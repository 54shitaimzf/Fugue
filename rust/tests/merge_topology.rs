//! Immutable topology planning, no-follow landing, and interrupted WAL recovery.
use fugue::{git::{Entry,Git},journal,merge,util};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::{BTreeMap,BTreeSet},fs,path::Path,process::Command};

type Tree=BTreeMap<String,Entry>;

fn prefixes(tree:&Tree)->Vec<String> {
    let mut result=BTreeSet::<String>::new();
    for path in tree.keys() {
        let mut path=path.as_str();
        while let Some((parent,_))=path.rsplit_once('/') { result.insert(parent.into()); path=parent; }
    }
    let mut result=result.into_iter().collect::<Vec<_>>();
    result.sort_by_key(|path|path.matches('/').count());
    result
}

fn write_tree(root:&Path,git:&Git,tree:&Tree) {
    for path in prefixes(tree) { util::ensure_dir(&root.join(path),0o750).unwrap(); }
    for (path,entry) in tree {
        util::replace_leaf(&root.join(path),Some(&util::Leaf{mode:entry.mode,bytes:git.blob(&entry.id).unwrap()})).unwrap();
    }
}

fn clear_tree(root:&Path,tree:&Tree) {
    let mut paths=tree.keys().collect::<Vec<_>>();
    paths.sort_by_key(|path|std::cmp::Reverse(path.matches('/').count()));
    for path in paths { util::replace_leaf(&root.join(path),None).unwrap(); }
    for path in prefixes(tree).into_iter().rev() { util::remove_empty_dir(&root.join(path)).unwrap(); }
}

fn tree(git:&Git,files:&[(&str,u32,&[u8])])->Tree {
    files.iter().map(|(path,mode,bytes)| ((*path).into(),Entry{
        kind:if *mode==0o120000{"symlink"}else{"file"}.into(),mode:*mode,id:git.put_blob(bytes).unwrap()
    })).collect()
}

fn fixture(files:&[(&str,u32,&[u8])])->(tempfile::TempDir,Git,String,Tree) {
    let dir=tempfile::tempdir().unwrap();
    assert!(Command::new("git").args(["init","-q","--initial-branch=main"]).arg(dir.path()).status().unwrap().success());
    let git=Git::open(dir.path()).unwrap();
    let original=tree(&git,files);
    let base=git.commit_tree(&git.put_tree(&original).unwrap(),&[],"topology base").unwrap();
    git.advance("refs/heads/main",&base,None).unwrap();
    write_tree(dir.path(),&git,&original);
    assert!(Command::new("git").arg("-C").arg(dir.path()).args(["add","-A"]).status().unwrap().success());
    (dir,git,base,original)
}

fn target(git:&Git,base:&str,files:&[(&str,u32,&[u8])])->(String,Tree) {
    let leaves=tree(git,files);
    let commit=git.commit_tree(&git.put_tree(&leaves).unwrap(),&[base.into()],"topology target").unwrap();
    (commit,leaves)
}

fn rows(root:&Path)->Vec<Value> { journal::read(root,"round").unwrap().into_iter().map(|row|row.event).collect() }

fn actual(root:&Path,expected:&Tree,git:&Git) {
    for (path,entry) in expected {
        let leaf=util::leaf(&root.join(path)).unwrap().unwrap();
        assert_eq!(leaf.mode,entry.mode,"mode of {path}");
        assert_eq!(leaf.bytes,git.blob(&entry.id).unwrap(),"bytes of {path}");
    }
}

fn latest_wal(root:&Path)->Value {
    rows(root).into_iter().rev().find(|row|row["t"]=="advance/begin").unwrap()
}

#[test]
fn directory_to_file_or_symlink_deletes_only_declared_old_leaves_without_following_links() {
    for mode in [0o100644,0o120000] {
        let outside=tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"),b"outside is immutable").unwrap();
        let old_link=outside.path().to_str().unwrap().as_bytes();
        let (dir,git,base,_)=fixture(&[("docs/nested/old",0o100644,b"old"),("docs/outside",0o120000,old_link)]);
        let index=fs::read(dir.path().join(".git/index")).unwrap();
        let (commit,leaves)=target(&git,&base,&[("docs",mode,b"new-docs")]);
        assert_eq!(merge::drift(dir.path(),&base,&commit).unwrap()["ok"],true);
        let result=merge::advance_verified(dir.path(),"r1",&base,&commit).unwrap();
        assert_eq!(result["written"],json!(["docs"]));
        actual(dir.path(),&leaves,&git);
        assert_eq!(fs::read(outside.path().join("keep")).unwrap(),b"outside is immutable");
        assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(),index);
        assert_eq!(git.resolve("refs/heads/main").unwrap(),Some(commit.clone()));
        let metadata=fs::symlink_metadata(dir.path().join("docs")).unwrap();
        let before=std::os::unix::fs::MetadataExt::mtime_nsec(&metadata);
        assert_eq!(merge::advance_verified(dir.path(),"r2",&commit,&commit).unwrap()["written"],json!([]));
        assert_eq!(std::os::unix::fs::MetadataExt::mtime_nsec(&fs::symlink_metadata(dir.path().join("docs")).unwrap()),before);
    }
}

#[test]
fn file_or_outside_symlink_to_directory_creates_ancestors_before_writing_children() {
    for mode in [0o100644,0o120000] {
        let outside=tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"),b"do not follow old root").unwrap();
        let initial=if mode==0o120000 { outside.path().to_str().unwrap().as_bytes() } else { b"old root" };
        let (dir,git,base,_)=fixture(&[("node",mode,initial),("unchanged",0o100644,b"keep")]);
        let index=fs::read(dir.path().join(".git/index")).unwrap();
        let (commit,leaves)=target(&git,&base,&[("node/a",0o100755,b"first"),("node/nested/b",0o100644,b"second"),("unchanged",0o100644,b"keep")]);
        assert_eq!(merge::drift(dir.path(),&base,&commit).unwrap()["ok"],true);
        merge::advance_verified(dir.path(),"r1",&base,&commit).unwrap();
        actual(dir.path(),&leaves,&git);
        assert_eq!(util::path_mode(&dir.path().join("node")).unwrap().unwrap()&0o7777,0o700);
        assert_eq!(fs::read(outside.path().join("keep")).unwrap(),b"do not follow old root");
        assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(),index);
    }
}

#[test]
fn untracked_edited_empty_or_protected_descendant_refuses_before_any_landing() {
    for shape in ["untracked-file","untracked-empty-directory","edited","protected"] {
        let (dir,git,base,_)=fixture(&[("docs/nested/old",0o100644,b"old"),("first",0o100644,b"first old")]);
        match shape {
            "untracked-file"=>{util::mkdirs_secure(&dir.path().join("docs/local")).unwrap();fs::write(dir.path().join("docs/local/keep"),b"untracked").unwrap();},
            "untracked-empty-directory"=>{util::mkdirs_secure(&dir.path().join("docs/local")).unwrap();},
            "edited"=>fs::write(dir.path().join("docs/nested/old"),b"user edit").unwrap(),
            _=>{util::mkdirs_secure(&dir.path().join("docs/.fugue")).unwrap();fs::write(dir.path().join("docs/.fugue/keep"),b"protected").unwrap();},
        }
        let index=fs::read(dir.path().join(".git/index")).unwrap();
        let (commit,_)=target(&git,&base,&[("docs",0o120000,b"new-docs"),("first",0o100644,b"first new")]);
        assert!(merge::advance_verified(dir.path(),"r1",&base,&commit).is_err(),"{shape}");
        assert_eq!(fs::read(dir.path().join("first")).unwrap(),b"first old");
        assert!(fs::symlink_metadata(dir.path().join("docs")).unwrap().is_dir());
        assert_eq!(git.resolve("refs/heads/main").unwrap(),Some(base));
        assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(),index);
        assert!(!rows(dir.path()).iter().any(|row|row["t"]=="advance/begin"));
    }
}

#[test]
fn preserved_descendant_preflight_is_complete_even_when_the_preserved_prefix_is_absent() {
    for mode in [0o100644,0o120000] {
        let (dir,git,base,_)=fixture(&[("docs/public",0o100644,b"old"),("first",0o100644,b"old first")]);
        let (commit,_)=target(&git,&base,&[("docs",mode,b"replacement"),("first",0o100644,b"new first")]);
        let error=merge::advance_verified_with_preserve(dir.path(),"r1",&base,&commit,&["docs/local".into()]).unwrap_err();
        assert!(error.message.contains("docs/local"));
        assert_eq!(fs::read(dir.path().join("first")).unwrap(),b"old first");
        assert_eq!(fs::read(dir.path().join("docs/public")).unwrap(),b"old");
        assert!(!rows(dir.path()).iter().any(|row|row["t"]=="advance/begin"));
    }
}

#[test]
fn preserved_prefix_allows_sibling_updates_and_retains_edited_content_and_modes() {
    let (dir,git,base,_)=fixture(&[("docs/local/keep",0o100644,b"old tracked"),("docs/public",0o100644,b"old public")]);
    fs::write(dir.path().join("docs/local/keep"),b"user-owned preserved edit").unwrap();
    util::ensure_dir(&dir.path().join("docs/local"),0o751).unwrap();
    let (commit,_)=target(&git,&base,&[("docs/public",0o100644,b"new public")]);
    let result=merge::advance_verified_with_preserve(dir.path(),"r1",&base,&commit,&["docs/local".into()]).unwrap();
    assert_eq!(result["written"],json!(["docs/public"]));
    assert_eq!(fs::read(dir.path().join("docs/local/keep")).unwrap(),b"user-owned preserved edit");
    assert_eq!(util::path_mode(&dir.path().join("docs/local")).unwrap().unwrap()&0o7777,0o751);
}

#[test]
fn all_effective_parent_permissions_are_checked_before_first_changed_leaf_or_wal() {
    let (dir,git,base,_)=fixture(&[("first",0o100644,b"first old"),("last/leaf",0o100644,b"last old")]);
    let (commit,_)=target(&git,&base,&[("first",0o100644,b"first new"),("last/leaf",0o100644,b"last new")]);
    util::ensure_dir(&dir.path().join("last"),0o500).unwrap();
    let result=merge::advance_verified(dir.path(),"r1",&base,&commit);
    util::ensure_dir(&dir.path().join("last"),0o750).unwrap();
    assert!(result.is_err(),"fixture must prove actual effective permission denial");
    assert_eq!(fs::read(dir.path().join("first")).unwrap(),b"first old");
    assert_eq!(fs::read(dir.path().join("last/leaf")).unwrap(),b"last old");
    assert!(!rows(dir.path()).iter().any(|row|row["t"]=="advance/begin"));
}

fn pending_wal(root:&Path,git:&Git,base:&str,commit:&str,original:&Tree,target:&Tree)->Value {
    merge::advance_verified(root,"r1",base,commit).unwrap();
    let mut wal=latest_wal(root);
    clear_tree(root,target);
    write_tree(root,git,original);
    git.advance("refs/heads/main",base,Some(commit)).unwrap();
    wal["tx"]=json!("crash-topology");
    journal::append(root,"round",wal.clone()).unwrap();
    wal
}

#[test]
fn directory_to_symlink_wal_all_forward_prefixes_roll_back_or_finish_without_following_old_link() {
    for prefix in 0..5 {
        for forward in [false,true] {
            let outside=tempfile::tempdir().unwrap();
            fs::write(outside.path().join("keep"),b"outside keep").unwrap();
            let old_link=outside.path().to_str().unwrap().as_bytes();
            let (dir,git,base,original)=fixture(&[("docs/nested/old",0o100644,b"old"),("docs/outside",0o120000,old_link)]);
            let (commit,target)=target(&git,&base,&[("docs",0o120000,b"new-docs")]);
            pending_wal(dir.path(),&git,&base,&commit,&original,&target);
            if prefix>=1 {util::replace_leaf(&dir.path().join("docs/nested/old"),None).unwrap();}
            if prefix>=2 {util::replace_leaf(&dir.path().join("docs/outside"),None).unwrap();}
            if prefix>=3 {util::remove_empty_dir(&dir.path().join("docs/nested")).unwrap();util::remove_empty_dir(&dir.path().join("docs")).unwrap();}
            if prefix>=4 {util::replace_leaf(&dir.path().join("docs"),Some(&util::Leaf{mode:0o120000,bytes:b"new-docs".to_vec()})).unwrap();}
            if forward {git.advance("refs/heads/main",&commit,Some(&base)).unwrap();}
            let index=fs::read(dir.path().join(".git/index")).unwrap();
            assert_eq!(merge::recover(dir.path()).unwrap()["recovered"],1,"prefix {prefix}, forward {forward}");
            actual(dir.path(),if forward{&target}else{&original},&git);
            if !forward {assert_eq!(util::path_mode(&dir.path().join("docs/nested")).unwrap().unwrap()&0o7777,0o750);}
            assert_eq!(fs::read(outside.path().join("keep")).unwrap(),b"outside keep");
            assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(),index);
            assert_eq!(merge::recover(dir.path()).unwrap()["recovered"],0);
        }
    }
}

#[test]
fn file_to_directory_wal_all_prefixes_have_safe_forward_and_rollback_ordering() {
    for prefix in 0..5 {
        for forward in [false,true] {
            let (dir,git,base,original)=fixture(&[("node",0o100755,b"old executable")]);
            let (commit,target)=target(&git,&base,&[("node/a",0o100644,b"new a"),("node/nested/b",0o100755,b"new b")]);
            pending_wal(dir.path(),&git,&base,&commit,&original,&target);
            if prefix>=1 {util::replace_leaf(&dir.path().join("node"),None).unwrap();}
            if prefix>=2 {util::ensure_dir(&dir.path().join("node"),0o700).unwrap();}
            if prefix>=3 {util::replace_leaf(&dir.path().join("node/a"),Some(&util::Leaf{mode:0o100644,bytes:b"new a".to_vec()})).unwrap();}
            if prefix>=4 {util::ensure_dir(&dir.path().join("node/nested"),0o700).unwrap();util::replace_leaf(&dir.path().join("node/nested/b"),Some(&util::Leaf{mode:0o100755,bytes:b"new b".to_vec()})).unwrap();}
            if forward {git.advance("refs/heads/main",&commit,Some(&base)).unwrap();}
            assert_eq!(merge::recover(dir.path()).unwrap()["recovered"],1,"prefix {prefix}, forward {forward}");
            actual(dir.path(),if forward{&target}else{&original},&git);
            assert_eq!(merge::recover(dir.path()).unwrap()["recovered"],0);
        }
    }
}

#[test]
fn rollback_does_not_remove_new_untracked_descendants_or_overwrite_postcrash_edits() {
    for shape in ["untracked-leaf","untracked-directory","edited-leaf"] {
        let (dir,git,base,original)=fixture(&[("node",0o100644,b"old root")]);
        let (commit,target)=target(&git,&base,&[("node/a",0o100644,b"new a")]);
        pending_wal(dir.path(),&git,&base,&commit,&original,&target);
        util::replace_leaf(&dir.path().join("node"),None).unwrap();
        util::ensure_dir(&dir.path().join("node"),0o700).unwrap();
        fs::write(dir.path().join("node/a"),b"new a").unwrap();
        match shape {
            "untracked-leaf"=>fs::write(dir.path().join("node/keep"),b"new user data").unwrap(),
            "untracked-directory"=>util::ensure_dir(&dir.path().join("node/keep"),0o700).unwrap(),
            _=>fs::write(dir.path().join("node/a"),b"edited user data").unwrap(),
        }
        let history=rows(dir.path());
        assert!(merge::recover(dir.path()).is_err(),"{shape}");
        assert_eq!(rows(dir.path()),history);
        assert_eq!(fs::read(dir.path().join("node/a")).unwrap(),if shape=="edited-leaf"{b"edited user data".as_slice()}else{b"new a".as_slice()});
        assert!(dir.path().join("node/keep").exists()||shape=="edited-leaf");
        assert_eq!(git.resolve("refs/heads/main").unwrap(),Some(base));
    }
}

#[test]
fn hostile_wal_directory_metadata_cannot_chmod_or_remove_unrelated_paths() {
    for shape in ["outside-path","duplicate","bad-mode","arbitrary-chmod","creation-mode","missing-field","extra-field"] {
        let (dir,git,base,original)=fixture(&[("node",0o100644,b"old root"),("unrelated/keep",0o100644,b"keep")]);
        let (commit,target)=target(&git,&base,&[("node/a",0o100644,b"new a"),("unrelated/keep",0o100644,b"keep")]);
        merge::advance_verified(dir.path(),"r1",&base,&commit).unwrap();
        let mut wal=latest_wal(dir.path());
        clear_tree(dir.path(),&target); write_tree(dir.path(),&git,&original);
        git.advance("refs/heads/main",&base,Some(&commit)).unwrap();
        wal["tx"]=json!("hostile");
        match shape {
            "outside-path"=>wal["directories"][0]["path"]=json!("unrelated"),
            "duplicate"=>{let item=wal["directories"][0].clone();wal["directories"].as_array_mut().unwrap().push(item);},
            "bad-mode"=>wal["directories"][0]["new"]=json!(0o40000),
            "arbitrary-chmod"=>wal["directories"][0]["old"]=json!(0o750),
            "missing-field"=>{wal["directories"][0].as_object_mut().unwrap().remove("old");},
            "extra-field"=>wal["directories"][0]["unrecognized"]=json!(true),
            _=>wal["directories"][0]["new"]=json!(0o777),
        }
        journal::append(dir.path(),"round",wal).unwrap();
        let history=rows(dir.path());
        assert!(merge::recover(dir.path()).is_err(),"{shape}");
        assert_eq!(rows(dir.path()),history);
        actual(dir.path(),&original,&git);
        assert_eq!(util::path_mode(&dir.path().join("unrelated")).unwrap().unwrap()&0o7777,0o750);
    }
}

#[test]
fn invalid_symlink_bytes_are_planned_before_an_earlier_ordinary_write() {
    let (dir,git,base,_)=fixture(&[("first",0o100644,b"old first"),("last",0o100644,b"old last")]);
    let (commit,_)=target(&git,&base,&[("first",0o100644,b"new first"),("last",0o120000,b"bad\0target")]);
    assert!(merge::advance_verified(dir.path(),"r1",&base,&commit).is_err());
    assert_eq!(fs::read(dir.path().join("first")).unwrap(),b"old first");
    assert_eq!(fs::read(dir.path().join("last")).unwrap(),b"old last");
    assert!(!rows(dir.path()).iter().any(|row|row["t"]=="advance/begin"));
}

#[test]
fn new_unsafe_target_symlink_is_rejected_before_other_changed_paths() {
    let (dir,git,base,_)=fixture(&[("first",0o100644,b"old"),("node/a",0o100644,b"old a")]);
    let (commit,_)=target(&git,&base,&[("first",0o100644,b"new"),("node",0o120000,b"/outside")]);
    assert!(merge::advance_verified(dir.path(),"r1",&base,&commit).is_err());
    assert_eq!(fs::read(dir.path().join("first")).unwrap(),b"old");
    assert_eq!(fs::read(dir.path().join("node/a")).unwrap(),b"old a");
    assert!(!rows(dir.path()).iter().any(|row|row["t"]=="advance/begin"));
}

#[test]
fn missing_directory_plan_and_multiple_pending_advances_fail_before_mutation() {
    for shape in ["missing-plan","multiple-pending"] {
        let (dir,git,base,original)=fixture(&[("node",0o100644,b"old root")]);
        let (commit,target)=target(&git,&base,&[("node/a",0o100644,b"new a")]);
        merge::advance_verified(dir.path(),"r1",&base,&commit).unwrap();
        let mut wal=latest_wal(dir.path());
        clear_tree(dir.path(),&target);write_tree(dir.path(),&git,&original);
        git.advance("refs/heads/main",&base,Some(&commit)).unwrap();
        wal["tx"]=json!("first-pending");
        if shape=="missing-plan" {wal["directories"]=json!([]);git.advance("refs/heads/main",&commit,Some(&base)).unwrap();}
        journal::append(dir.path(),"round",wal.clone()).unwrap();
        if shape=="multiple-pending" {wal["tx"]=json!("second-pending");journal::append(dir.path(),"round",wal).unwrap();}
        let history=rows(dir.path());
        assert!(merge::recover(dir.path()).is_err(),"{shape}");
        assert_eq!(rows(dir.path()),history);
        actual(dir.path(),&original,&git);
    }
}

#[test]
#[ignore="explicit upstream 0.2.3 Node differential oracle"]
fn upstream_023_directory_symlink_and_preserved_ancestor_preflight_match_native() {
    let source=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let bytes=fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/merge-accept-0.2.3.ts")).unwrap();
    assert_eq!(format!("{:x}",Sha256::digest(&bytes)),"ad22ea3def9362aece17c784e574d9010633cafc554592ad0c6225e8eec2217c",
        "the vendored upstream 0.2.3 oracle must remain byte-exact");
    let text=String::from_utf8(bytes).unwrap();
    let imports=regex::Regex::new(r"from '(\.\.?/[^']+)'").unwrap();
    let text=imports.replace_all(&text,|capture:&regex::Captures| {
        let path=source.join("src/merge").join(&capture[1]).canonicalize().unwrap();
        format!("from {}",serde_json::to_string(path.to_str().unwrap()).unwrap())
    });
    let module=tempfile::tempdir().unwrap();
    let module_path=module.path().join("accept-023.ts");
    fs::write(&module_path,text.as_bytes()).unwrap();
    let script=r#"const [module,source,root,commit,preserve]=process.argv.slice(1);
const {openTruth}=await import(source+'/src/truth/truth.ts');
const {advance}=await import(module); const truth=openTruth(root);
try { const result=await advance({truth,realRoot:root,preserve:JSON.parse(preserve)},commit);
console.log(JSON.stringify({ok:true,result})); }
catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
finally {await truth.close();}"#;
    let oracle=|root:&Path,commit:&str,preserve:Value| {
        let output=Command::new("node").args(["--input-type=module","--eval",script])
            .arg(&module_path).arg(source).arg(root).arg(commit).arg(serde_json::to_string(&preserve).unwrap()).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let outside=tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep"),b"external keep").unwrap();
    let old_link=outside.path().to_str().unwrap().as_bytes();
    let initial=[("docs/nested/old",0o100644,b"old".as_slice()),("docs/outside",0o120000,old_link)];
    let (native,git,base,_)=fixture(&initial);
    let (node,node_git,node_base,_)=fixture(&initial);
    let (commit,expected)=target(&git,&base,&[("docs",0o120000,b"new-docs")]);
    let (node_commit,_)=target(&node_git,&node_base,&[("docs",0o120000,b"new-docs")]);
    let native_result=merge::advance_verified(native.path(),"r1",&base,&commit).unwrap();
    let node_result=oracle(node.path(),&node_commit,json!([".git",".fugue"]));
    assert_eq!(node_result["ok"],true);
    assert_eq!(node_result["result"]["written"],native_result["written"]);
    actual(native.path(),&expected,&git);actual(node.path(),&expected,&node_git);
    assert_eq!(fs::read(outside.path().join("keep")).unwrap(),b"external keep");
    for mode in [0o100644,0o120000] {
        let initial=[("docs/public",0o100644,b"old".as_slice()),("first",0o100644,b"first old")];
        let (native,git,base,original)=fixture(&initial);
        let (node,node_git,node_base,_)=fixture(&initial);
        let files=[("docs",mode,b"replacement".as_slice()),("first",0o100644,b"first new")];
        let (commit,_)=target(&git,&base,&files);
        let (node_commit,_)=target(&node_git,&node_base,&files);
        assert!(merge::advance_verified_with_preserve(native.path(),"r1",&base,&commit,&["docs/local".into()]).is_err());
        let result=oracle(node.path(),&node_commit,json!([".git",".fugue","docs/local"]));
        assert_eq!(result["ok"],false);assert!(result["error"].as_str().unwrap().contains("docs/local"));
        actual(native.path(),&original,&git);actual(node.path(),&original,&node_git);
    }
}
