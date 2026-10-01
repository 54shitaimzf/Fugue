//! Host-capability acceptance tests. Run explicitly with --ignored on a supported
//! Linux kernel; an unavailable required layer is a failing acceptance result.
use fugue::{sandbox, view, git::Git, probe};
use serde_json::json;
use std::{fs, path::Path, process::Command};
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    assert!(Command::new("/usr/bin/git").args(["init", "-q", "-b", "main"]).arg(d.path()).status().unwrap().success());
    let g = Git::open(d.path()).unwrap();
    let t = g.put_tree(&Default::default()).unwrap();
    let c = g.commit_tree(&t, &[], "base").unwrap();
    g.advance("refs/heads/main", &c, None).unwrap();
    view::branch(d.path(), "agent/test", "main").unwrap();
    d
}
fn require(root: &Path) {
    let p = sandbox::policy(root, None, &json!({})).unwrap();
    assert_eq!(p["available"], true, "required kernel isolation unavailable: {}", p["note"]);
    assert_eq!(p["enforcement"], "full");
}
#[test]
#[ignore = "requires successful native Landlock ABI>=6 and seccomp installation"]
fn required_guard_installs_both_native_layers() {
    let r = Command::new(env!("CARGO_BIN_EXE_fugue")).args(["__fugue-guard", "--probe"]).output().unwrap();
    assert!(r.status.success(), "native guard not installed: {}", String::from_utf8_lossy(&r.stderr));
    assert_eq!(r.stdout, b"fugue-guard-v1\n");
}
#[test]
#[ignore = "requires successful bubblewrap namespaces and native guard"]
fn required_new_exact_file_output_succeeds_and_reclaims_safely() {
    let d = repo(); require(d.path());
    let r = sandbox::execute(d.path(), "agent/test", &["/bin/sh".into(), "-c".into(), "printf verified > answer.txt".into()], &json!({"mode":"workspace-write","outputs":["answer.txt"]})).unwrap();
    assert_eq!(r["exit"], 0, "{r}"); assert_eq!(r["denied"], false);
    let v = view::View::load(d.path(), "agent/test", None).unwrap();
    assert_eq!(v.read("answer.txt").unwrap().unwrap(), b"verified");
    assert!(!d.path().join("answer.txt").exists());
    assert!(probe::metrics(&fugue::journal::merged(d.path()).unwrap(), &json!({})).is_ok());
}
#[test]
#[ignore = "requires successful bubblewrap namespaces and native guard"]
fn required_declared_cache_persists_without_becoming_git_content() {
    let d = repo(); require(d.path());
    fs::write(d.path().join(".fugue/config"), serde_json::to_vec(&json!({"actions":{"seed":{"argv":["/bin/sh","-c","printf cached > cache-dir/value"],"cache":["cache-dir"]},"read":{"argv":["/bin/sh","-c","cat cache-dir/value"],"cache":["cache-dir"]}}})).unwrap()).unwrap();
    let a = sandbox::run(d.path(), "agent/test", "seed", &[], &json!({})).unwrap();
    assert_eq!(a["exit"], 0, "{a}"); assert_eq!(a["denied"], false);
    let b = sandbox::run(d.path(), "agent/test", "read", &[], &json!({})).unwrap();
    assert_eq!(b["exit"], 0, "{b}"); assert_eq!(b["stdout"], "cached");
    let v = view::View::load(d.path(), "agent/test", None).unwrap();
    assert_eq!(v.rev, 0); assert!(v.entries.keys().all(|p|!p.starts_with("cache-dir")));
    assert!(!d.path().join("cache-dir").exists());
}
#[test]
#[ignore = "requires successful bubblewrap namespaces and native guard"]
fn required_outside_write_is_denied_with_no_host_effect() {
    let d = repo(); require(d.path());
    let outside = tempfile::tempdir().unwrap(); let p = outside.path().join("host-sentinel");
    let r = sandbox::execute(d.path(), "agent/test", &["/bin/sh".into(), "-c".into(), format!("printf escaped > '{}'", p.display())], &json!({})).unwrap();
    assert_ne!(r["exit"], 0, "{r}"); assert_eq!(r["denied"], true); assert!(!p.exists());
    assert_eq!(view::View::load(d.path(), "agent/test", None).unwrap().rev, 0);
    assert!(probe::metrics(&fugue::journal::merged(d.path()).unwrap(), &json!({})).is_ok());
}
#[test]
#[ignore = "requires successful network namespace isolation; no external network requests"]
fn required_no_net_action_has_a_private_loopback_only_namespace() {
    let d = repo(); require(d.path());
    let host = fs::read_link("/proc/self/ns/net").unwrap().to_string_lossy().into_owned();
    let r = sandbox::execute(d.path(), "agent/test", &["/bin/sh".into(), "-c".into(), "readlink /proc/self/ns/net; cat /proc/net/dev".into()], &json!({})).unwrap();
    assert_eq!(r["exit"], 0, "{r}"); assert_eq!(r["denied"], false);
    let out = r["stdout"].as_str().unwrap(); assert_ne!(out.lines().next().unwrap(), host);
    let interfaces = out.lines().filter_map(|l|l.split_once(':').map(|(n,_)|n.trim())).collect::<Vec<_>>();
    assert_eq!(interfaces, ["lo"]);
}
