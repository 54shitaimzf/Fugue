//! Real filesystem and bounded subprocess failure regressions. These tests do
//! not claim a successful kernel-isolation result on an unsupported host.
use fugue::{git::Git, journal, sandbox, tools, view};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path, process::{Command, Stdio}, thread, time::{Duration, Instant}};
use std::os::unix::{ffi::OsStrExt, fs::symlink};

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    assert!(Command::new("/usr/bin/git").args(["init", "-q", "-b", "main"]).arg(d.path()).status().unwrap().success());
    let g = Git::open(d.path()).unwrap();
    let t = g.put_tree(&BTreeMap::new()).unwrap();
    let base = g.commit_tree(&t, &[], "base").unwrap();
    g.advance("refs/heads/main", &base, None).unwrap();
    view::branch(d.path(), "agent/test", "main").unwrap();
    fs::create_dir_all(d.path().join(".fugue")).unwrap();
    d
}
fn config(root: &Path, v: Value) {
    fs::write(root.join(".fugue/config"), serde_json::to_vec(&v).unwrap()).unwrap();
}

#[test]
fn malformed_policy_containers_are_not_silently_defaulted() {
    let d = repo();
    for bad in [json!({"boundary":false}), json!({"boundary":[]}), json!({"ports":"31000-31099"}), json!({"boundary":{"enforcment":"partial"}})] {
        config(d.path(), bad.clone());
        assert!(sandbox::policy(d.path(), None, &json!({})).is_err(), "accepted {bad}");
    }
}

#[test]
fn malformed_action_docs_and_nonobject_options_fail_before_receipts() {
    let d = repo();
    config(d.path(), json!({"actions":{"bad":{"argv":["true"],"doc":27}}}));
    let before = journal::read(d.path(), "agent/test").unwrap();
    assert!(sandbox::run(d.path(), "agent/test", "bad", &[], &json!({})).is_err());
    config(d.path(), json!({"actions":{"ok":{"argv":["true"]}}}));
    for bad in [json!(null), json!([]), json!(false)] {
        assert!(sandbox::run(d.path(), "agent/test", "ok", &[], &bad).is_err());
        assert!(sandbox::execute(d.path(), "agent/test", &["true".into()], &bad).is_err());
        assert!(sandbox::policy(d.path(), None, &bad).is_err());
    }
    assert_eq!(journal::read(d.path(), "agent/test").unwrap().len(), before.len());
}

#[test]
fn composed_symlink_escape_is_refused_before_materialization_mutates() {
    let d = repo();
    let f = sandbox::fork(d.path(), "agent/test", "main", &json!({"strategy":"copy"})).unwrap();
    let merged = Path::new(f["merged"].as_str().unwrap());
    let mut v = view::View::load(d.path(), "agent/test", None).unwrap();
    v.symlink("d/link", "../").unwrap();
    v.symlink("bad", "d/link/..").unwrap();
    let before = journal::read(d.path(), "agent/test").unwrap().len();
    assert!(sandbox::ensure(d.path(), "agent/test", None).is_err());
    assert_eq!(journal::read(d.path(), "agent/test").unwrap().len(), before);
    assert!(!merged.join("bad").exists());
    assert!(fs::symlink_metadata(merged.join("bad")).is_err());
}

#[test]
fn symlink_cycles_fail_bounded_and_safe_dangling_links_remain_supported() {
    let d = repo();
    sandbox::fork(d.path(), "agent/test", "main", &json!({"strategy":"copy"})).unwrap();
    let mut v = view::View::load(d.path(), "agent/test", None).unwrap();
    v.symlink("safe", "missing/file").unwrap();
    sandbox::ensure(d.path(), "agent/test", None).unwrap();
    v.symlink("a", "b").unwrap();
    v.symlink("b", "a").unwrap();
    assert!(sandbox::ensure(d.path(), "agent/test", None).is_err());
}

#[test]
fn special_materialization_lock_does_not_block_the_cli() {
    let d = repo();
    let lock = d.path().join(".fugue/locks/materialize/agent/test.lock");
    fs::create_dir_all(lock.parent().unwrap()).unwrap();
    let name = std::ffi::CString::new(lock.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let mut child = Command::new(env!("CARGO_BIN_EXE_fugue")).args(["fork", "main", "--agent", "agent/test", "--root"]).arg(d.path()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().unwrap() { assert!(!status.success()); break; }
        if Instant::now() >= deadline {
            child.kill().unwrap(); child.wait().unwrap();
            panic!("FIFO lock blocked instead of being refused");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn mixed_output_specialfiles_and_symlink_parents_cannot_touch_outside_state() {
    let d = repo();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep"), b"outside").unwrap();
    let f = sandbox::fork(d.path(), "agent/test", "main", &json!({"strategy":"copy"})).unwrap();
    let merged = Path::new(f["merged"].as_str().unwrap());
    symlink(outside.path(), merged.join("out")).unwrap();
    let mut v = view::View::load(d.path(), "agent/test", None).unwrap();
    v.write("out/keep", b"bad", None).unwrap();
    assert!(sandbox::ensure(d.path(), "agent/test", None).is_err());
    assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"outside");
    fs::remove_file(merged.join("out")).unwrap();
    let fifo = std::ffi::CString::new(merged.join("out").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(sandbox::ensure(d.path(), "agent/test", None).is_err());
    assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"outside");
}

#[test]
fn oversized_grep_receipts_are_refused_before_constructing_match_strings() {
    let d = repo();
    let mut v = view::View::load(d.path(), "agent/test", None).unwrap();
    v.write("huge-line", &vec![b'x'; 2 * 1024 * 1024], None).unwrap();
    let r = tools::invoke(d.path(), "agent/test", "grep", &json!({"pattern":"x"})).unwrap();
    assert_eq!(r["ok"], false, "unbounded grep formatting was allowed");
    assert!(r["output"].as_str().unwrap().contains("receipt byte budget"));
}

#[test]
fn mandatory_network_block_is_fail_closed_for_explicit_partial_request() {
    let d = repo();
    config(d.path(), json!({"boundary":{"enforcement":"partial"},"actions":{"network":{"argv":["/bin/sh","-c","touch /work/should-not-run"],"net":"host"}}}));
    let policy = sandbox::policy(d.path(), Some("network"), &json!({})).unwrap();
    let r = sandbox::run(d.path(), "agent/test", "network", &[], &json!({})).unwrap();
    if policy["available"] == false {
        assert_eq!(r["exit"], 126);
        assert_eq!(r["enforcement"], "blocked");
        assert_eq!(r["denied"], true);
        assert!(r["stderr"].as_str().unwrap().contains("no command was executed"));
        assert!(!d.path().join(".fugue/mat/agent/test/merged/should-not-run").exists());
    } else {
        assert_eq!(r["denied"], true); // No writable output was declared.
    }
    assert!(!d.path().join("should-not-run").exists());
}

#[test]
fn expanded_edits_and_invalid_runtime_context_leave_the_view_unchanged() {
    let d=repo();let mut v=view::View::load(d.path(),"agent/test",None).unwrap();
    v.write("small",&vec![b'x';1025],None).unwrap();let before=v.rev;
    let result=tools::invoke(d.path(),"agent/test","edit",&json!({"path":"small","old_string":"x","new_string":"z".repeat(65536),"replace_all":true})).unwrap();
    assert_eq!(result["ok"],false);assert!(result["output"].as_str().unwrap().contains("edited file exceeds byte budget"));
    for key in ["__holder","__writable"] {
        let result=tools::invoke(d.path(),"agent/test","write",&json!({"path":"small","content":"bad",key:"true"})).unwrap();
        assert_eq!(result["ok"],false);
    }
    let after=view::View::load(d.path(),"agent/test",None).unwrap();assert_eq!(after.rev,before);assert_eq!(after.read("small").unwrap().unwrap(),vec![b'x';1025]);
}

#[test]
fn combined_argument_budgets_are_checked_before_subprocess_receipts() {
    let d=repo();let arg="x".repeat(90000);
    config(d.path(),json!({"actions":{"oversized":{"argv":["true"],"doc":"ok"}}}));
    let before=journal::read(d.path(),"agent/test").unwrap().len();
    assert!(sandbox::run(d.path(),"agent/test","oversized",&[],&json!({"extra":vec![arg;12]})).is_err());
    assert!(sandbox::run(d.path(),"agent/test","oversized",&vec!["KEY=value".into();257],&json!({})).is_err());
    assert_eq!(journal::read(d.path(),"agent/test").unwrap().len(),before);
}
