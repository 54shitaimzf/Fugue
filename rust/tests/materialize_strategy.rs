use fugue::{sandbox, view, git::Git, journal, config};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    for (p,b) in [("vendor/lib","immutable\n"),("src/a","one\n"),("src/deep/b","two\n")] {
        fs::create_dir_all(d.path().join(p).parent().unwrap()).unwrap();
        fs::write(d.path().join(p),b).unwrap();
    }
    for a in [vec!["init","-q","-b","main"],vec!["add","."],vec!["-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","base"]] {
        assert!(Command::new("/usr/bin/git").args(a).current_dir(d.path()).status().unwrap().success());
    }
    view::branch(d.path(),"agent/a","main").unwrap(); d
}
fn materialize(r:&Path,o:Value)->Value { sandbox::fork(r,"agent/a","main",&o).unwrap() }
#[test]
fn strategy_preferences_follow_the_upstream_ladder_without_false_labels() {
    let d=repo();
    for (o,s) in [(json!({"strategy":"overlayfs"}),"copy"),(json!({"strategy":"reflink"}),"copy"),(json!({"strategy":"hardlink-ro"}),"copy"),(json!({"strategy":"overlayfs","ro":"vendor"}),"hardlink-ro"),(json!({"strategy":"reflink","readOnlyPaths":["vendor"]}),"hardlink-ro"),(json!({"strategy":"copy","ro":"vendor"}),"copy")] {
        let r=materialize(d.path(),o); assert_eq!(r["strategy"],s); assert_eq!(r["mount"],Value::Null);
        assert!(r["why"].as_str().unwrap().contains(s));
        assert_eq!(r["facts"]["overlayfs"],Value::Null);
        assert_eq!(sandbox::verify(d.path(),"agent/a").unwrap()["ok"],true);
    }
    let merged=d.path().join(".fugue/mat/agent/a/merged/src/a"); let inode=fs::metadata(&merged).unwrap().ino();
    for o in [json!({"strategy":"unknown"}),json!({"strategy":false}),json!({"ro":"../bad"}),json!({"ro":"vendor","readOnlyPaths":[]}),json!({"detectRenames":"true"})] {
        assert!(sandbox::fork(d.path(),"agent/a","main",&o).is_err());
        assert_eq!(fs::metadata(&merged).unwrap().ino(),inode);
    }
}
#[test]
fn hardlink_ro_uses_only_private_git_lower_and_detaches_before_content_or_mode_changes() {
    let d=repo(); let host=fs::metadata(d.path().join("vendor/lib")).unwrap();
    fs::write(d.path().join("vendor/lib"),"dirty user worktree").unwrap();
    let r=materialize(d.path(),json!({"strategy":"hardlink-ro","ro":"vendor"}));
    let mat=d.path().join(".fugue/mat/agent/a"); let low=mat.join("lower/vendor/lib"); let merged=mat.join("merged/vendor/lib");
    assert_eq!(r["laid"]["links"],1); assert_eq!(fs::read(&merged).unwrap(),b"immutable\n");
    let lower=fs::metadata(&low).unwrap(); let linked=fs::metadata(&merged).unwrap();
    assert_eq!((lower.dev(),lower.ino()),(linked.dev(),linked.ino())); assert_eq!(lower.nlink(),2); assert_ne!(host.ino(),lower.ino());
    assert_eq!(lower.mode()&0o222,0);
    let mut v=view::View::load(d.path(),"agent/a",None).unwrap(); v.chmod("vendor/lib",0o755).unwrap();
    sandbox::ensure(d.path(),"agent/a",None).unwrap();
    assert_ne!(fs::metadata(&merged).unwrap().ino(),lower.ino()); assert_eq!(fs::metadata(&low).unwrap().mode()&0o111,0);
    v.write("vendor/lib",b"changed through view",None).unwrap(); sandbox::ensure(d.path(),"agent/a",None).unwrap();
    assert_eq!(fs::read(&low).unwrap(),b"immutable\n"); assert_eq!(fs::read(&merged).unwrap(),b"changed through view");
    assert_eq!(fs::read(d.path().join("vendor/lib")).unwrap(),b"dirty user worktree");
    view::branch(d.path(),"agent/b","main").unwrap(); sandbox::fork(d.path(),"agent/b","main",&json!({"ro":"vendor"})).unwrap();
    assert_ne!(fs::metadata(d.path().join(".fugue/mat/agent/b/lower/vendor/lib")).unwrap().ino(),lower.ino());
    assert_eq!(sandbox::verify(d.path(),"agent/a").unwrap()["ok"],true);
    sandbox::dispose(d.path(),"agent/a").unwrap(); assert_eq!(fs::read(d.path().join("vendor/lib")).unwrap(),b"dirty user worktree");
}
#[test]
fn mirror_identity_and_link_count_are_verified_before_read_or_disposal() {
    let d=repo(); materialize(d.path(),json!({"ro":"vendor"}));
    let low=d.path().join(".fugue/mat/agent/a/lower/vendor/lib"); let merged=d.path().join(".fugue/mat/agent/a/merged/vendor/lib");
    let extra=d.path().join("unowned-link"); fs::hard_link(&low,&extra).unwrap();
    assert!(sandbox::verify(d.path(),"agent/a").unwrap_err().message.contains("unowned hardlinks"));
    assert!(sandbox::diff_stat(d.path(),"agent/a",&json!({})).is_err()); assert!(sandbox::dispose(d.path(),"agent/a").is_err());
    assert!(merged.exists()); fs::remove_file(extra).unwrap();
    fs::set_permissions(&merged,fs::Permissions::from_mode(0o644)).unwrap();
    assert!(sandbox::verify(d.path(),"agent/a").unwrap_err().message.contains("identity/mode"));
    fs::set_permissions(&merged,fs::Permissions::from_mode(0o444)).unwrap();
    assert_eq!(sandbox::verify(d.path(),"agent/a").unwrap()["ok"],true);
    let original=fs::metadata(&low).unwrap(); fs::remove_file(&merged).unwrap(); fs::remove_file(&low).unwrap();
    fs::write(&low,b"immutable\n").unwrap(); fs::set_permissions(&low,fs::Permissions::from_mode(0o444)).unwrap(); fs::hard_link(&low,&merged).unwrap();
    assert_ne!(fs::metadata(&low).unwrap().ino(),original.ino());
    assert!(sandbox::verify(d.path(),"agent/a").is_err()); assert!(sandbox::dispose(d.path(),"agent/a").is_err());
    assert_eq!(fs::read(d.path().join("vendor/lib")).unwrap(),b"immutable\n");
}
#[test]
fn validated_advisory_controls_keep_content_validation_and_prune_override_is_real() {
    for prune in [false,true] {
        let d=repo(); let r=materialize(d.path(),json!({"strategy":"copy","changeDetector":"mtime-size","detectRenames":true,"pruneEmptyDirs":prune}));
        assert_eq!(r["options"]["changeDetector"],"mtime-size"); assert_eq!(r["options"]["detectRenames"],true);
        let mut v=view::View::load(d.path(),"agent/a",None).unwrap();v.remove("src/deep/b").unwrap();sandbox::ensure(d.path(),"agent/a",None).unwrap();
        assert_eq!(d.path().join(".fugue/mat/agent/a/merged/src/deep").exists(),!prune);
        assert_eq!(sandbox::verify(d.path(),"agent/a").unwrap()["ok"],true);
        fs::write(d.path().join(".fugue/mat/agent/a/merged/src/a"),b"bad\n").unwrap();
        assert!(sandbox::ensure(d.path(),"agent/a",None).is_err());
    }
}
#[test]
fn apply_intent_resumes_only_matching_final_bytes_and_finishes_older_target_before_latest() {
    let d=repo(); materialize(d.path(),json!({"strategy":"copy"}));
    let mut v=view::View::load(d.path(),"agent/a",None).unwrap();v.write("src/a",b"approved first",None).unwrap();let first=v.rev;
    journal::append(d.path(),"agent/a",json!({"t":"mat/apply","agent":"agent/a","base":v.base,"from":0,"to":first})).unwrap();
    fs::write(d.path().join(".fugue/mat/agent/a/merged/src/a"),b"approved first").unwrap();
    v.write("src/a",b"approved latest",None).unwrap();sandbox::ensure(d.path(),"agent/a",None).unwrap();
    assert_eq!(fs::read(d.path().join(".fugue/mat/agent/a/merged/src/a")).unwrap(),b"approved latest");
    assert_eq!(sandbox::verify(d.path(),"agent/a").unwrap()["ok"],true);
    let sync=journal::read(d.path(),"agent/a").unwrap().into_iter().filter(|r|r.event["t"]=="mat/sync").collect::<Vec<_>>();assert_eq!(sync.len(),2);assert_eq!(sync[0].event["to"],first);
    v.write("src/a",b"third",None).unwrap();journal::append(d.path(),"agent/a",json!({"t":"mat/apply","agent":"agent/a","base":v.base,"from":sync[1].event["to"],"to":v.rev})).unwrap();
    fs::write(d.path().join(".fugue/mat/agent/a/merged/src/a"),b"unauthorized drift").unwrap();assert!(sandbox::ensure(d.path(),"agent/a",None).is_err());
}
#[test]
fn fork_publish_intent_recovers_before_and_after_directory_publication() {
    for already_published in [false,true] {
        let d=repo(); materialize(d.path(),json!({"ro":"vendor"}));
        let event=journal::read(d.path(),"agent/a").unwrap().into_iter().find(|r|r.event["t"]=="mat/fork").unwrap().event;
        let mat=d.path().join(".fugue/mat/agent/a");let stage=mat.join("stage-test-crash");fs::create_dir(&stage).unwrap();
        if !already_published {for k in ["merged","lower"]{fs::rename(mat.join(k),stage.join(k)).unwrap();}}
        journal::append(d.path(),"agent/a",json!({"t":"mat/fork-ready","agent":"agent/a","stage":"stage-test-crash","next":event})).unwrap();
        assert!(sandbox::verify(d.path(),"agent/a").is_err());sandbox::ensure(d.path(),"agent/a",None).unwrap();
        assert_eq!(sandbox::verify(d.path(),"agent/a").unwrap()["ok"],true);assert!(!stage.exists());
        assert_eq!(fs::metadata(mat.join("lower/vendor/lib")).unwrap().nlink(),2);
    }
}
#[test]
fn public_version_probes_cache_without_running_untrusted_config_commands() {
    let d=repo();let sentinel=d.path().join("would-write");
    config::set(d.path(),"toolchain",&serde_json::to_string(&json!({"git":{"probe":["git","--version"],"doc":"version"},"hostile":{"probe":["/bin/sh","-c",format!("printf forbidden > '{}'",sentinel.display())]}})).unwrap(),false).unwrap();
    let first=sandbox::toolchain(d.path()).unwrap();assert!(!sentinel.exists());
    let cfg=config::read(d.path()).unwrap();assert!(cfg["toolchain"]["git"]["reading"]["value"].as_str().unwrap().starts_with("git version "));assert_eq!(cfg["toolchain"]["hostile"]["reading"]["value"],Value::Null);
    let second=sandbox::toolchain(d.path()).unwrap();assert_eq!(second.as_array().unwrap().iter().find(|r|r["name"]=="git").unwrap()["cached"],true);
    assert!(first.as_array().unwrap().iter().find(|r|r["name"]=="hostile").unwrap()["note"].as_str().unwrap().contains("probe"));assert!(!sentinel.exists());
    config::set(d.path(),"toolchain",r#"{"git":{"probe":["git","--help"],"reading":{"probe":["git","--version"],"value":"stale"}}}"#,false).unwrap();
    sandbox::toolchain(d.path()).unwrap();assert_eq!(config::read(d.path()).unwrap()["toolchain"]["git"]["reading"]["value"],Value::Null);
}
#[test]
fn copy_chmod_retains_inode_and_mtime_while_hardlink_chmod_detaches() {
    let d=repo();materialize(d.path(),json!({"strategy":"copy"}));let p=d.path().join(".fugue/mat/agent/a/merged/src/a");let before=fs::metadata(&p).unwrap();
    let mut v=view::View::load(d.path(),"agent/a",None).unwrap();v.chmod("src/a",0o755).unwrap();sandbox::ensure(d.path(),"agent/a",None).unwrap();let after=fs::metadata(&p).unwrap();
    assert_eq!(before.ino(),after.ino());assert_eq!((before.mtime(),before.mtime_nsec()),(after.mtime(),after.mtime_nsec()));assert_ne!(after.mode()&0o111,0);
    assert!(Git::open(d.path()).unwrap().resolve("main").unwrap().is_some());
}
#[test]
fn every_fork_swap_crash_phase_recovers_copy_and_hardlink_without_mutating_old_mirror() {
    for hard in [false,true] { for phase in 0..5 {
        let d=repo(); materialize(d.path(),json!({"ro":"vendor"}));
        let mut next=journal::read(d.path(),"agent/a").unwrap().into_iter().find(|r|r.event["t"]=="mat/fork").unwrap().event;
        let mat=d.path().join(".fugue/mat/agent/a"); let stage=mat.join("stage-swap-test");
        fs::create_dir(&stage).unwrap();fs::create_dir(stage.join("merged")).unwrap();fs::create_dir(stage.join("lower")).unwrap();
        let g=Git::open(d.path()).unwrap();let base=g.tree(next["base"].as_str().unwrap()).unwrap();let mut provenance=serde_json::Map::new();
        for(p,a)in base {let b=g.blob(&a.id).unwrap();let dest=stage.join("merged").join(&p);fs::create_dir_all(dest.parent().unwrap()).unwrap();
            if hard&&p=="vendor/lib" {let low=stage.join("lower").join(&p);fs::create_dir_all(low.parent().unwrap()).unwrap();fs::write(&low,&b).unwrap();fs::set_permissions(&low,fs::Permissions::from_mode(0o444)).unwrap();fs::hard_link(&low,&dest).unwrap();let m=fs::metadata(&low).unwrap();provenance.insert(p,json!({"dev":m.dev().to_string(),"ino":m.ino().to_string()}));}
            else {fs::write(&dest,&b).unwrap();fs::set_permissions(&dest,fs::Permissions::from_mode(a.mode&0o777)).unwrap();}
        }
        next["strategy"]=json!(if hard{"hardlink-ro"}else{"copy"});if hard{next["lower"]=json!(provenance);}else{next.as_object_mut().unwrap().remove("lower");}
        journal::append(d.path(),"agent/a",json!({"t":"mat/fork-ready","agent":"agent/a","stage":"stage-swap-test","next":next})).unwrap();
        let old=fs::metadata(mat.join("lower/vendor/lib")).unwrap().ino();
        if phase>=1{fs::rename(mat.join("merged"),stage.join("old-merged")).unwrap();}
        if phase>=2{fs::rename(mat.join("lower"),stage.join("old-lower")).unwrap();}
        if phase>=3 {if hard{fs::rename(stage.join("lower"),mat.join("lower")).unwrap();}else{fs::remove_dir(stage.join("lower")).unwrap();}}
        if phase>=4{fs::rename(stage.join("merged"),mat.join("merged")).unwrap();}
        sandbox::ensure(d.path(),"agent/a",None).unwrap();let verified=sandbox::verify(d.path(),"agent/a").unwrap();assert_eq!(verified["ok"],true,"hard={hard}, phase={phase}: {verified}");assert_eq!(verified["strategy"],if hard{"hardlink-ro"}else{"copy"});
        assert!(!stage.exists());if hard{assert_ne!(fs::metadata(mat.join("lower/vendor/lib")).unwrap().ino(),old);}else{assert!(!mat.join("lower").exists());}
        assert_eq!(fs::read(d.path().join("vendor/lib")).unwrap(),b"immutable\n");
    }}
}
#[test]
#[ignore = "requires upstream Node differential oracle"]
fn strategy_choice_matches_the_pure_upstream_oracle_for_unavailable_overlay() {
    let cases=json!([{}, {"preferredStrategy":"copy","readOnlyPaths":["vendor"]}, {"preferredStrategy":"reflink"}, {"preferredStrategy":"overlayfs","readOnlyPaths":["vendor"]}, {"preferredStrategy":"hardlink-ro"}]);
    let source=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("src/materialize/capability.ts");
    let script=format!("import{{chooseStrategy}}from{};const facts={{fs:'native',overlayfs:null,overlayfsNote:'unavailable',hardlink:true,whiteout:null,whiteoutNote:'unavailable'}};const cases={};console.log(JSON.stringify(cases.map(o=>chooseStrategy(facts,{{preserveMtime:true,changeDetector:'content-hash',detectRenames:false,pruneEmptyDirs:true,...o}}).choice.strategy)));",serde_json::to_string(&source.to_string_lossy()).unwrap(),cases);
    let result=Command::new("node").args(["--input-type=module","--eval",&script]).output().unwrap();assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));let expected:Value=serde_json::from_slice(&result.stdout).unwrap();
    let d=repo();for(o,e)in cases.as_array().unwrap().iter().zip(expected.as_array().unwrap()){let r=materialize(d.path(),o.clone());assert_eq!(&r["strategy"],e);}
}
#[test]
fn hardlink_subtree_diffstat_and_clean_symlink_mtime_preservation_work() {
    let d=repo();
    std::os::unix::fs::symlink("vendor/lib",d.path().join("link")).unwrap();
    for a in [vec!["add","link"],vec!["-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","link"]]{assert!(Command::new("git").args(a).current_dir(d.path()).status().unwrap().success());}
    view::branch(d.path(),"agent/with-link","main").unwrap();let before=fs::symlink_metadata(d.path().join("link")).unwrap();
    let r=sandbox::fork(d.path(),"agent/with-link","main",&json!({"ro":"vendor"})).unwrap();let after=fs::symlink_metadata(Path::new(r["merged"].as_str().unwrap()).join("link")).unwrap();
    assert_eq!((before.mtime(),before.mtime_nsec()),(after.mtime(),after.mtime_nsec()));
    let stats=sandbox::diff_stat(d.path(),"agent/with-link",&json!({"dir":Path::new(r["merged"].as_str().unwrap()).join("vendor")})).unwrap();
    assert_eq!(stats["paths"],1);assert_eq!(stats["leaves"][0]["path"],"lib");
}
#[test]
fn diagnostic_version_api_resolves_fixed_trusted_public_executables() {
    let git=sandbox::version_probe(&["git".into(),"--version".into()]).unwrap();
    assert!(git["value"].as_str().unwrap().starts_with("git version "));
    assert!(git["note"].as_str().unwrap().contains("sanitized environment"));
    let bwrap=sandbox::version_probe(&["bwrap".into(),"--version".into()]).unwrap();
    assert!(bwrap["value"].as_str().unwrap().starts_with("bubblewrap "));
    assert!(sandbox::version_probe(&[]).is_err());
    assert!(sandbox::version_probe(&["git".into(),"--version\0x".into()]).is_err());
}
