//! Native subprocess integration and hostile durable-prefix regressions.
//! No provider requests or weakened isolation are permitted in this suite.
use fugue::{assemble, contracts, git::{Entry, Git}, journal, merge, model, round, tools, util, view::View};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::Write, path::Path, process::{Command, Output, Stdio}};

fn assignment(path: &str) -> Value {
    json!({"goal":format!("write {path}"),"ownedPaths":[path],
        "deliverables":[{"path":path,"form":"file"}],
        "assertions":[{"name":"checked","action":"check","expect":0}]})
}

fn fixture(split: Value) -> (tempfile::TempDir, Git, String) {
    let dir = tempfile::tempdir().unwrap();
    assert!(Command::new("git").args(["init", "-q", "--initial-branch=main"])
        .arg(dir.path()).status().unwrap().success());
    let git = Git::open(dir.path()).unwrap();
    let mut tree = BTreeMap::new();
    tree.insert("tracked".into(), Entry { kind:"file".into(), mode:0o100644,
        id:git.put_blob(b"original tracked\n").unwrap() });
    let base = git.commit_tree(&git.put_tree(&tree).unwrap(), &[], "fixture base").unwrap();
    git.advance("refs/heads/main", &base, None).unwrap();
    fs::write(dir.path().join("tracked"), b"original tracked\n").unwrap();
    assert!(Command::new("git").arg("-C").arg(dir.path()).args(["add", "tracked"])
        .status().unwrap().success());
    util::atomic_write(&dir.path().join(".fugue/config"), &serde_json::to_vec(&json!({
        "round":{"id":"r1","split":split}, "actions":{"check":{"argv":["/usr/bin/true"]}}
    })).unwrap()).unwrap();
    (dir, git, base)
}

fn call(root: &Path, args: &[&str], input: Option<&[u8]>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_fugue"))
        .arg("--root").arg(root).arg("--json").args(args)
        .env("FUGUE_SYSTEM_DIR", root.join("absent-system-config"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    if let Some(bytes) = input { child.stdin.take().unwrap().write_all(bytes).unwrap(); }
    else { drop(child.stdin.take()); }
    child.wait_with_output().unwrap()
}

fn value(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| panic!(
        "stdout is not JSON: {error}; status {}; stdout {}; stderr {}", output.status,
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

fn success(root: &Path, args: &[&str]) -> Value {
    let output = call(root, args, None);
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    value(&output)
}

fn events(root: &Path, writer: &str) -> Vec<Value> {
    journal::read(root, writer).unwrap().into_iter().map(|row| row.event).collect()
}

fn state(root: &Path, from: &str, to: &str) {
    journal::append(root, "round", json!({"t":"round/state","round":"r1","from":from,"to":to})).unwrap();
}

fn host(root: &Path, git: &Git) -> (Option<String>, Vec<u8>, Vec<u8>) {
    (git.resolve("refs/heads/main").unwrap(), fs::read(root.join("tracked")).unwrap(),
        fs::read(root.join(".git/index")).unwrap())
}

fn complete_worker(root: &Path, contract: &Value, paths: &[(&str, &[u8])], stopped_contract: &str) -> Value {
    let writer = contract["agent"].as_str().unwrap();
    let mut view = View::load(root, writer, None).unwrap();
    for (path, bytes) in paths { view.write(path, bytes, None).unwrap(); }
    let checkpoint = view.checkpoint("completed fixture worker").unwrap();
    journal::append(root, writer, json!({"t":"agent/stop","agent":writer,
        "contract":stopped_contract,"reason":"end-turn","stopped":"done","steps":0})).unwrap();
    checkpoint
}

fn request(state: &Value) -> Vec<u8> {
    let prefix = assemble::from_state(state, "subagent").unwrap();
    let mut request = json!({"model":"deepseek-flash",
        "zones":{"A":prefix.a,"B":prefix.b,"C":prefix.c}, "tools":tools::catalog(),
        "call":{"thinking":"high","maxTokens":32768}});
    if state["turns"].as_array().is_some_and(|turns| !turns.is_empty()) {
        request["turns"] = state["turns"].clone();
    }
    if state["runtime"].as_str().is_some_and(|head| !head.is_empty()) {
        request["cHead"] = state["runtime"].clone();
    }
    model::encode("anthropic-messages", &request).unwrap()
}

fn response(write: bool) -> Vec<u8> {
    let mut frames = vec![json!({"type":"message_start",
        "message":{"model":"deepseek-flash","usage":{"input_tokens":31}}})];
    frames.push(if write { json!({"type":"content_block_start","index":0,"content_block":{
        "type":"tool_use","id":"write-once","name":"write","input":{"path":"result","content":"once\n"}}})
    } else { json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"done"}}) });
    frames.push(json!({"type":"content_block_stop","index":0}));
    frames.push(json!({"type":"message_delta","delta":{"stop_reason":if write {"tool_use"} else {"end_turn"}},
        "usage":{"output_tokens":7}}));
    frames.push(json!({"type":"message_stop"}));
    frames.into_iter().map(|frame| format!("data: {}\n\n", serde_json::to_string(&frame).unwrap()))
        .collect::<String>().into_bytes()
}

fn recording(dir: &Path, number: u64, request: &[u8], response: &[u8]) {
    let path = dir.join(format!("call-{number:04}"));
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("request.json"), request).unwrap();
    fs::write(path.join("response.sse"), response).unwrap();
    fs::write(path.join("meta.json"), serde_json::to_vec(&json!({
        "requestHash":assemble::hash(request), "responseHash":assemble::hash(response)
    })).unwrap()).unwrap();
}

#[test]
fn cli_draft_revision_invalidates_displayed_approval_and_duplicate_go_is_inert() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    success(dir.path(), &["round", "plan", "initial goal"]);
    let original = events(dir.path(), "round").into_iter().rev()
        .find(|event| event["t"] == "holder/distill").unwrap()["digest"].as_str().unwrap().to_owned();
    success(dir.path(), &["config", "set", "round.split", &serde_json::to_string(&json!([assignment("revised")])).unwrap()]);
    success(dir.path(), &["round", "plan", "initial goal"]);
    let before = events(dir.path(), "round");
    let refs = git.run(&["show-ref"], None).unwrap();
    let stale = call(dir.path(), &["round", "go", "--expected-digest", &original], None);
    assert_eq!(stale.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&stale.stderr).contains("changed after display"));
    assert_eq!(events(dir.path(), "round"), before);
    assert_eq!(git.run(&["show-ref"], None).unwrap(), refs);
    let digest = before.iter().rev().find(|event| event["t"] == "holder/distill").unwrap()["digest"].as_str().unwrap();
    let issued = success(dir.path(), &["round", "go", "--expected-digest", digest]);
    assert_eq!(issued["base"], base);
    assert_eq!(issued["contracts"][0]["ownedPaths"], json!(["revised"]));
    let before = events(dir.path(), "round");
    assert_eq!(call(dir.path(), &["round", "go"], None).status.code(), Some(1));
    assert_eq!(events(dir.path(), "round"), before);
    assert!(!dir.path().join("revised").exists());
}

#[test]
fn cli_new_work_and_run_refuse_unisolated_verification_without_host_side_effects() {
    for direct_run in [false, true] {
        let (dir, git, _) = fixture(json!([assignment("result")]));
        let marker = dir.path().join("must-not-exist");
        success(dir.path(), &["config", "set", "actions.check", &serde_json::to_string(&json!({
            "argv":["/bin/sh","-c",format!("printf escaped > '{}'", marker.display())]
        })).unwrap()]);
        let before = host(dir.path(), &git);
        let output = if direct_run { call(dir.path(), &["round", "run", "goal", "--retry", "0"], None) }
            else { success(dir.path(), &["round", "new", "goal"]); call(dir.path(), &["round", "work", "--retry", "0"], None) };
        assert_eq!(output.status.code(), Some(1));
        let result = value(&output);
        assert_eq!(result["ok"], false);
        assert_eq!(result["state"], "Aborted");
        assert_eq!(host(dir.path(), &git), before);
        assert!(!marker.exists());
        assert!(!dir.path().join("result").exists());
        assert!(!events(dir.path(), "round").iter().any(|event| event["t"] == "advance/begin" || event["t"] == "merge/accept"));
    }
}

#[test]
fn cli_paused_replay_resumes_exactly_once_across_processes() {
    let (dir, git, _) = fixture(json!([assignment("result")]));
    let wire = tempfile::tempdir().unwrap();
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let contract = &issued["contracts"][0];
    let writer = contract["agent"].as_str().unwrap();
    let opts = json!({"contract":contract,"goal":contract["goal"],"protocol":"subagent",
        "wire-in":wire.path(),"max-steps":"1"});
    recording(wire.path(), 1, &request(&assemble::initial_state(dir.path(), &opts).unwrap()), &response(true));
    let before = host(dir.path(), &git);
    let first = call(dir.path(), &["round", "work", "--wire-in", wire.path().to_str().unwrap(), "--max-steps", "1"], None);
    assert_eq!(first.status.code(), Some(1));
    assert_eq!(value(&first)["paused"], true);
    assert_eq!(value(&first)["state"], "Working");
    let rows = events(dir.path(), writer);
    let mut saved = rows.iter().find(|event| event["t"] == "runtime/start").unwrap()["state"].clone();
    for step in rows.iter().filter(|event| event["t"] == "runtime/step") {
        saved["turns"].as_array_mut().unwrap().push(step["turn"].clone());
        saved["lastStep"] = step["lastStep"].clone();
    }
    let before_notice = assemble::from_state(&saved, "subagent").unwrap();
    saved["runtime"] = json!(model::step_notice(&saved, 2, 1).unwrap());
    let after_notice = assemble::from_state(&saved, "subagent").unwrap();
    assert_eq!(before_notice.a, after_notice.a);
    assert_eq!(before_notice.b, after_notice.b);
    assert!(after_notice.c.contains("current explicit cap is 2"));
    recording(wire.path(), 2, &request(&saved), &response(false));
    let second = call(dir.path(), &["round", "work", "--wire-in", wire.path().to_str().unwrap(),
        "--max-steps", "2", "--retry", "0"], None);
    let result = value(&second);
    assert_eq!(result["agents"][0]["done"], true, "{result}");
    assert_eq!(result["agents"][0]["steps"], 2);
    let rows = events(dir.path(), writer);
    assert_eq!(rows.iter().filter(|event| event["t"] == "runtime/start").count(), 1);
    assert_eq!(rows.iter().filter(|event| event["t"] == "view/write").count(), 1);
    assert_eq!(rows.iter().filter(|event| event["t"] == "tool/receipt").count(), 1);
    assert_eq!(rows.iter().filter(|event| event["t"] == "llm/call").count(), 2);
    assert_eq!(View::load(dir.path(), writer, None).unwrap().read("result").unwrap().unwrap(), b"once\n");
    assert_eq!(host(dir.path(), &git), before);
    assert!(!dir.path().join("result").exists());
}

#[test]
fn completed_worker_outside_surface_is_rejected_before_candidate_creation() {
    let (dir, git, _) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let contract = &issued["contracts"][0];
    complete_worker(dir.path(), contract, &[("result", b"allowed"), ("unapproved", b"must not merge")], contract["id"].as_str().unwrap());
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    assert!(!output.status.success());
    assert!(!events(dir.path(), "round").iter().any(|event| event["t"] == "merge/candidate"),
        "an unapproved worker path reached the merge candidate");
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn completed_worker_missing_deliverable_is_not_reused_as_success() {
    let (dir, git, _) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let contract = &issued["contracts"][0];
    complete_worker(dir.path(), contract, &[], contract["id"].as_str().unwrap());
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    assert!(!output.status.success());
    assert!(!events(dir.path(), "round").iter().any(|event| event["t"] == "merge/candidate"),
        "an incomplete deliverable was accepted on the restart path");
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn pending_overlay_cannot_hide_outside_paths_in_the_immutable_worker_commit() {
    let (dir, git, _) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let contract = &issued["contracts"][0];
    complete_worker(dir.path(), contract, &[("result", b"allowed"), ("unapproved", b"committed escape")],
        contract["id"].as_str().unwrap());
    let mut overlay = View::load(dir.path(), "agent/r1/1", None).unwrap();
    overlay.remove("unapproved").unwrap();
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    assert!(!output.status.success());
    assert!(!events(dir.path(), "round").iter().any(|event| event["t"] == "merge/candidate"),
        "validating the overlay concealed an out-of-surface path in the folded commit");
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn stop_receipt_for_another_contract_does_not_complete_current_worker() {
    let (dir, git, _) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    complete_worker(dir.path(), &issued["contracts"][0], &[("result", b"stale work")], "other.implement.1");
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    assert!(!output.status.success());
    let result = value(&output);
    assert_eq!(result["reused"], json!([]), "a stop receipt for another contract was reused");
    let worker = View::load(dir.path(), "agent/r1/1", None).unwrap();
    assert!(String::from_utf8(worker.read("result").unwrap().unwrap()).unwrap().contains("r1.implement.1"));
    assert!(events(dir.path(), "agent/r1/1").iter().any(|event|
        event["t"] == "agent/stop" && event["contract"] == "r1.implement.1"));
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn cli_strict_merge_gate_rejects_overlap_before_workers_or_resolver_run() {
    let (dir, git, _) = fixture(json!([assignment("result"), assignment("result")]));
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "run", "goal", "--strict-merge-gate", "--retry", "0"], None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("strict merge gate"), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(events(dir.path(), "agent/r1/1").is_empty());
    assert!(!events(dir.path(), "round").iter().any(|event| event["t"] == "resolve/issue"));
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn cli_genuine_conflict_is_resolved_and_refolded_before_safe_assertion_refusal() {
    let (dir, git, _) = fixture(json!([assignment("result"), assignment("result")]));
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "run", "goal", "--fail", "checked", "--retry", "0"], None);
    assert_eq!(output.status.code(), Some(1));
    let result = value(&output);
    assert_eq!(result["fold"]["kind"], "folded");
    assert_eq!(result["fold"]["resolutions"], 1);
    let candidate = events(dir.path(), "round").into_iter().find(|event| event["t"] == "merge/candidate").unwrap();
    let tree = git.tree(candidate["commit"].as_str().unwrap()).unwrap();
    assert!(String::from_utf8(git.blob(&tree["result"].id).unwrap()).unwrap().contains("r1.implement.2"));
    assert_eq!(events(dir.path(), "round").iter().filter(|event| event["t"] == "resolve/issue").count(), 1);
    assert_eq!(host(dir.path(), &git), before);
    assert!(!dir.path().join("result").exists());
}

#[test]
fn cli_investigation_evidence_is_excluded_from_merge_candidate() {
    let investigate = json!({"kind":"investigate","question":"what is known?",
        "evidenceRequired":[{"note":"facts"}],"seed":[]});
    let (dir, git, _) = fixture(json!([investigate, assignment("result")]));
    let before = host(dir.path(), &git);
    let output = call(dir.path(), &["round", "run", "goal", "--fail", "checked", "--retry", "0"], None);
    assert_eq!(output.status.code(), Some(1));
    let candidate = events(dir.path(), "round").into_iter().find(|event| event["t"] == "merge/candidate").unwrap();
    let tree = git.tree(candidate["commit"].as_str().unwrap()).unwrap();
    assert!(tree.contains_key("result"));
    assert!(tree.keys().all(|path| !path.starts_with("evidence/")));
    assert!(View::load(dir.path(), "agent/r1/1", None).unwrap().read("evidence/agent/r1/1/facts").unwrap().is_some());
    assert_eq!(host(dir.path(), &git), before);
    assert!(!dir.path().join("evidence").exists());
}

#[test]
fn cli_complete_candidate_prefix_reuses_checkpoint_and_keeps_late_user_edit_and_index() {
    let (dir, git, base) = fixture(json!([assignment("tracked")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let contract = &issued["contracts"][0];
    let checkpoint = complete_worker(dir.path(), contract, &[("tracked", b"worker changed\n")], contract["id"].as_str().unwrap());
    state(dir.path(), "Working", "Collecting");
    state(dir.path(), "Collecting", "Merging");
    let tree = checkpoint["tree"].as_str().unwrap();
    let target = git.commit_tree(tree, &[base.clone()], "candidate prefix").unwrap();
    journal::append(dir.path(), "round", json!({"t":"merge/candidate","round":"r1",
        "base":base,"tree":tree,"commit":target})).unwrap();
    state(dir.path(), "Merging", "Verifying");
    fs::write(dir.path().join("tracked"), b"late user change\n").unwrap();
    let before = host(dir.path(), &git);
    let worker = events(dir.path(), contract["agent"].as_str().unwrap());
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(value(&output)["drift"]["colliding"], json!(["tracked"]));
    assert_eq!(events(dir.path(), contract["agent"].as_str().unwrap()), worker);
    assert_eq!(events(dir.path(), "round").iter().filter(|event| event["t"] == "merge/candidate").count(), 1);
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn completed_resolver_crash_prefix_resumes_without_reissuing_or_repeating_edits() {
    let (dir, git, base) = fixture(json!([assignment("result"), assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let left = complete_worker(dir.path(), &issued["contracts"][0], &[("result", b"left\n")], "r1.implement.1");
    let right = complete_worker(dir.path(), &issued["contracts"][1], &[("result", b"right\n")], "r1.implement.2");
    state(dir.path(), "Working", "Collecting");
    state(dir.path(), "Collecting", "Merging");
    let folded = merge::fold(&git, &base, &[left["commit"].as_str().unwrap().into(), right["commit"].as_str().unwrap().into()]).unwrap();
    assert_eq!(folded["kind"], "conflict");
    let resolver_base = git.commit_tree(folded["tree"].as_str().unwrap(),
        &[folded["folded"].as_str().unwrap().into(), folded["rest"][0].as_str().unwrap().into()],
        "fugue conflict tree").unwrap();
    let cfg = serde_json::from_slice(&fs::read(dir.path().join(".fugue/config")).unwrap()).unwrap();
    let owner = "agent/r1/resolve-1";
    let resolver = contracts::resolve(dir.path(), &cfg, "r1", &resolver_base, &["result".into()],
        &issued["contracts"][0]["assertions"], owner).unwrap();
    git.advance(resolver["branch"].as_str().unwrap(), &resolver_base, None).unwrap();
    journal::append(dir.path(), "round", json!({"t":"resolve/issue","round":"r1",
        "contract":resolver["id"],"owner":owner,"paths":["result"],"body":serde_json::to_string(&resolver).unwrap()})).unwrap();
    complete_worker(dir.path(), &resolver, &[("result", b"right\n")], "r1.resolve.1");
    let before = host(dir.path(), &git);
    let resolver_history = events(dir.path(), owner);
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    let result = value(&output);
    assert_eq!(result["fold"]["kind"], "folded", "{result}");
    assert_eq!(events(dir.path(), owner), resolver_history);
    assert_eq!(events(dir.path(), "round").iter().filter(|event| event["t"] == "resolve/issue").count(), 1);
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn cli_repairs_only_partial_final_event_and_rejects_complete_corruption() {
    use std::fs::OpenOptions;
    for complete_corruption in [false, true] {
        let (dir, git, _) = fixture(json!([assignment("result")]));
        success(dir.path(), &["round", "plan", "goal"]);
        let file = dir.path().join(".fugue/log/round.jsonl");
        let complete = fs::read(&file).unwrap();
        let fragment = if complete_corruption { b"{\"t\":\"corruption\"}\n".as_slice() }
            else { b"{\"t\":\"interrupted-tail".as_slice() };
        OpenOptions::new().append(true).open(&file).unwrap().write_all(fragment).unwrap();
        let before = host(dir.path(), &git);
        let output = call(dir.path(), &["round", "go"], None);
        if complete_corruption {
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(fs::read(&file).unwrap(), [complete, fragment.to_vec()].concat());
            assert!(!dir.path().join(".git/refs/heads/agent").exists());
        } else {
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let repaired = fs::read(&file).unwrap();
            assert!(repaired.starts_with(&complete));
            assert!(!repaired.windows(fragment.len()).any(|bytes| bytes == fragment));
            assert_eq!(value(&output)["state"], "Working");
        }
        assert_eq!(host(dir.path(), &git), before);
    }
}

#[test]
fn valid_wal_omission_of_already_target_disk_leaf_remains_recoverable() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    let mut tree = git.tree(&base).unwrap();
    tree.get_mut("tracked").unwrap().id = git.put_blob(b"target bytes\n").unwrap();
    let target = git.commit_tree(&git.put_tree(&tree).unwrap(), &[base.clone()], "target").unwrap();
    fs::write(dir.path().join("tracked"), b"target bytes\n").unwrap();
    journal::append(dir.path(), "round", json!({"t":"advance/begin","round":"r1","tx":"already-target",
        "ref":"refs/heads/main","base":base,"commit":target,"changes":[]})).unwrap();
    git.advance("refs/heads/main", &target, Some(&base)).unwrap();
    let before = host(dir.path(), &git);
    assert_eq!(merge::recover(dir.path()).unwrap()["recovered"], 1);
    assert_eq!(events(dir.path(), "round").last().unwrap()["t"], "advance/end");
    assert_eq!(host(dir.path(), &git), before);
    assert_eq!(merge::recover(dir.path()).unwrap()["recovered"], 0);
}

#[test]
fn persisted_retry_transition_does_not_reset_attempt_budget_on_restart() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let checkpoint = complete_worker(dir.path(), &issued["contracts"][0],
        &[("result", b"initial worker\n")], "r1.implement.1");
    state(dir.path(), "Working", "Collecting");
    state(dir.path(), "Collecting", "Merging");
    let target = git.commit_tree(checkpoint["tree"].as_str().unwrap(), &[base.clone()], "first candidate").unwrap();
    journal::append(dir.path(), "round", json!({"t":"merge/candidate","round":"r1",
        "base":base,"tree":checkpoint["tree"],"commit":target})).unwrap();
    state(dir.path(), "Merging", "Verifying");
    journal::append(dir.path(), "round", json!({"t":"merge/invalidate","round":"r1",
        "commit":target,"attempt":0})).unwrap();
    state(dir.path(), "Verifying", "Working");
    let before = host(dir.path(), &git);
    // Explicit assertion injection is a native orchestration fixture, not shell execution.
    let result = round::command(dir.path(), "work", &[], &json!({"fail":"checked","retry":1})).unwrap();
    assert_eq!(result["state"], "Aborted");
    assert_eq!(result["retries"], 1);
    let rows = events(dir.path(), "round");
    assert_eq!(rows.iter().filter(|event| event["t"] == "merge/invalidate").count(), 1,
        "restart granted another retry after the approved allowance was already consumed");
    assert_eq!(rows.iter().filter(|event| event["t"] == "merge/candidate").count(), 2);
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn partial_retry_generation_reuses_only_already_completed_current_attempt() {
    let (dir, git, base) = fixture(json!([assignment("left"), assignment("right")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let left = complete_worker(dir.path(), &issued["contracts"][0], &[("left", b"initial left\n")], "r1.implement.1");
    let right = complete_worker(dir.path(), &issued["contracts"][1], &[("right", b"initial right\n")], "r1.implement.2");
    state(dir.path(), "Working", "Collecting");
    state(dir.path(), "Collecting", "Merging");
    let folded = merge::fold(&git, &base, &[left["commit"].as_str().unwrap().into(), right["commit"].as_str().unwrap().into()]).unwrap();
    let target = git.commit_tree(folded["tree"].as_str().unwrap(), &[base.clone()], "failed initial candidate").unwrap();
    journal::append(dir.path(), "round", json!({"t":"merge/candidate","round":"r1",
        "base":base,"tree":folded["tree"],"commit":target})).unwrap();
    state(dir.path(), "Merging", "Verifying");
    journal::append(dir.path(), "round", json!({"t":"merge/invalidate","round":"r1",
        "commit":target,"attempt":0,"feedback":"first attempt failed"})).unwrap();
    state(dir.path(), "Verifying", "Working");
    complete_worker(dir.path(), &issued["contracts"][0], &[("left", b"finished first retry cell\n")], "r1.implement.1");
    journal::append(dir.path(), "agent/r1/1", json!({"t":"agent/stop","agent":"agent/r1/1",
        "contract":"r1.implement.1","reason":"end-turn","stopped":"done","steps":0,"attempt":1})).unwrap();
    let already_done = events(dir.path(), "agent/r1/1");
    let old_second = events(dir.path(), "agent/r1/2");
    let before = host(dir.path(), &git);
    let result = round::command(dir.path(), "work", &[], &json!({"fail":"checked","retry":1})).unwrap();
    assert_eq!(result["state"], "Aborted");
    assert_eq!(result["retries"], 1);
    assert_eq!(result["reused"], json!(["r1.implement.1"]));
    assert_eq!(events(dir.path(), "agent/r1/1"), already_done);
    let second = events(dir.path(), "agent/r1/2");
    assert_eq!(second.iter().filter(|event| event["t"] == "view/write").count(),
        old_second.iter().filter(|event| event["t"] == "view/write").count() + 1);
    assert!(second.iter().any(|event| event["t"] == "agent/stop" && event["attempt"] == 1));
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn legitimate_overlap_retry_uses_fresh_resolver_lease_for_changed_worker_inputs() {
    let (dir, git, _) = fixture(json!([assignment("result"), assignment("result")]));
    let before = host(dir.path(), &git);
    // Each generation runs genuine Git conflicts; only the assertion outcome is injected.
    let result = round::command(dir.path(), "run", &["goal".into()], &json!({"fail":"checked","retry":1})).unwrap();
    assert_eq!(result["state"], "Aborted");
    assert_eq!(result["retries"], 1);
    let issues = events(dir.path(), "round").into_iter().filter(|event| event["t"] == "resolve/issue").collect::<Vec<_>>();
    assert_eq!(issues.len(), 2);
    assert_ne!(issues[0]["owner"], issues[1]["owner"], "different conflict inputs reused one resolver branch");
    assert_ne!(issues[0]["contract"], issues[1]["contract"]);
    assert_eq!(host(dir.path(), &git), before);
    assert!(!dir.path().join("result").exists());
}

#[test]
fn accepted_candidate_crash_prefix_advances_without_repeating_verification() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let checkpoint = complete_worker(dir.path(), &issued["contracts"][0],
        &[("result", b"accepted output\n")], "r1.implement.1");
    state(dir.path(), "Working", "Collecting");
    state(dir.path(), "Collecting", "Merging");
    let target = git.commit_tree(checkpoint["tree"].as_str().unwrap(), &[base.clone()], "accepted candidate").unwrap();
    journal::append(dir.path(), "round", json!({"t":"merge/candidate","round":"r1",
        "base":base,"tree":checkpoint["tree"],"commit":target})).unwrap();
    state(dir.path(), "Merging", "Verifying");
    // This receipt is injected orchestration evidence, not a claim that the native guard ran.
    journal::append(dir.path(), "round", json!({"t":"merge/accept","round":"r1","commit":target,
        "assertions":[{"assertion":"checked","verdict":"pass"}]})).unwrap();
    let index = fs::read(dir.path().join(".git/index")).unwrap();
    let output = call(dir.path(), &["round", "work", "--retry", "0"], None);
    assert!(output.status.success(), "{} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert_eq!(value(&output)["state"], "Rebuilding");
    assert_eq!(git.resolve("refs/heads/main").unwrap().as_deref(), Some(target.as_str()));
    assert_eq!(fs::read(dir.path().join("result")).unwrap(), b"accepted output\n");
    assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), index);
    assert!(events(dir.path(), "agent/r1/verify").is_empty(), "durable acceptance was needlessly verified again");
}

#[test]
fn post_cas_pending_wal_finishes_cli_round_from_durable_acceptance() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let checkpoint = complete_worker(dir.path(), &issued["contracts"][0],
        &[("result", b"landed output\n")], "r1.implement.1");
    state(dir.path(), "Working", "Collecting");
    state(dir.path(), "Collecting", "Merging");
    let target = git.commit_tree(checkpoint["tree"].as_str().unwrap(), &[base.clone()], "accepted candidate").unwrap();
    journal::append(dir.path(), "round", json!({"t":"merge/candidate","round":"r1",
        "base":base,"tree":checkpoint["tree"],"commit":target})).unwrap();
    state(dir.path(), "Merging", "Verifying");
    journal::append(dir.path(), "round", json!({"t":"merge/accept","round":"r1","commit":target,
        "assertions":[{"assertion":"checked","verdict":"pass"}]})).unwrap();
    let entry = git.tree(&target).unwrap()["result"].clone();
    journal::append(dir.path(), "round", json!({"t":"advance/begin","round":"r1","tx":"after-cas",
        "ref":"refs/heads/main","base":base,"commit":target,"changes":[{"path":"result","old":null,"new":entry}]})).unwrap();
    git.advance("refs/heads/main", &target, Some(&base)).unwrap();
    let index = fs::read(dir.path().join(".git/index")).unwrap();
    let result = success(dir.path(), &["round", "work"]);
    assert_eq!(result["state"], "Rebuilding");
    assert_eq!(result["recovered"], true);
    assert_eq!(fs::read(dir.path().join("result")).unwrap(), b"landed output\n");
    assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), index);
    assert_eq!(events(dir.path(), "round").iter().filter(|event| event["t"] == "advance/end").count(), 1);
    assert!(events(dir.path(), "agent/r1/verify").is_empty());
}

#[test]
fn wal_omitted_changed_leaf_cannot_claim_completed_recovery() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    let mut tree = git.tree(&base).unwrap();
    tree.get_mut("tracked").unwrap().id = git.put_blob(b"target bytes\n").unwrap();
    let target = git.commit_tree(&git.put_tree(&tree).unwrap(), &[base.clone()], "target").unwrap();
    journal::append(dir.path(), "round", json!({"t":"advance/begin","round":"r1","tx":"omitted",
        "ref":"refs/heads/main","base":base,"commit":target,"changes":[]})).unwrap();
    git.advance("refs/heads/main", &target, Some(&base)).unwrap();
    let before = host(dir.path(), &git);
    let rows = events(dir.path(), "round");
    assert!(merge::recover(dir.path()).is_err(), "incomplete WAL claimed completion with an unlanded target leaf");
    assert_eq!(events(dir.path(), "round"), rows);
    assert_eq!(host(dir.path(), &git), before);
}

#[test]
fn changed_binding_cannot_discard_ambiguous_mutating_tool_intent() {
    let (dir, _, _) = fixture(json!([assignment("result")]));
    let issued = success(dir.path(), &["round", "new", "goal"]);
    let contract = &issued["contracts"][0];
    let writer = contract["agent"].as_str().unwrap();
    let wire = tempfile::tempdir().unwrap();
    let opts = json!({"contract":contract,"goal":"initial goal","wire-in":wire.path(),"max-steps":1});
    recording(wire.path(), 1, &request(&assemble::initial_state(dir.path(), &opts).unwrap()), &response(true));
    model::drive(dir.path(), writer, &opts).unwrap();
    let rows = events(dir.path(), writer);
    for kind in ["runtime/start", "runtime/response", "runtime/tool-intent"] {
        let mut event = rows.iter().find(|event| event["t"] == kind).unwrap().clone();
        event["session"] = json!("interrupted-effect");
        journal::append(dir.path(), writer, event).unwrap();
    }
    let before = events(dir.path(), writer);
    let mut changed = opts.clone();
    changed["goal"] = json!("new goal must not waive review");
    let result = model::drive(dir.path(), writer, &changed).unwrap();
    assert!(!result["done"].as_bool().unwrap());
    assert!(result["stopped"].as_str().unwrap().starts_with("ambiguous"), "{result}");
    assert_eq!(events(dir.path(), writer), before, "a fresh request discarded the unresolved old effect");
    assert_eq!(View::load(dir.path(), writer, None).unwrap().rev, 1);
}

#[test]
#[ignore = "explicit upstream Node 24 differential oracle"]
fn real_three_branch_fold_and_conflict_stages_match_node() {
    let (dir, git, base) = fixture(json!([assignment("result")]));
    let mut commits = Vec::new();
    for (path, bytes) in [("left", b"left\n".as_slice()), ("right", b"right\n"), ("third", b"third\n")] {
        let mut tree = git.tree(&base).unwrap();
        tree.insert(path.into(), Entry {kind:"file".into(),mode:0o100644,id:git.put_blob(bytes).unwrap()});
        commits.push(git.commit_tree(&git.put_tree(&tree).unwrap(), &[base.clone()], "worker").unwrap());
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let script = r#"const [root,up,base,raw]=process.argv.slice(1);
const {openTruth}=await import(up+'/src/truth/truth.ts');
const {fold}=await import(up+'/src/merge/merge.ts');
const truth=openTruth(root); const result=await fold({truth},JSON.parse(raw));
console.log(JSON.stringify(result)); await truth.close();"#;
    let oracle = |commits: &[String]| {
        let output = Command::new("node").args(["--input-type=module", "--eval", script])
            .arg(dir.path()).arg(source).arg(&base).arg(serde_json::to_string(commits).unwrap()).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let native = merge::fold(&git, &base, &commits).unwrap();
    let node = oracle(&commits);
    assert_eq!(native["kind"], node["kind"]);
    assert_eq!(native["tree"], node["tree"]);
    assert_eq!(native["steps"], node["steps"]);
    let mut conflicts = Vec::new();
    for bytes in [b"left change\n".as_slice(), b"right change\n"] {
        let mut tree = git.tree(&base).unwrap();
        tree.get_mut("tracked").unwrap().id = git.put_blob(bytes).unwrap();
        conflicts.push(git.commit_tree(&git.put_tree(&tree).unwrap(), &[base.clone()], "conflict").unwrap());
    }
    let native = merge::fold(&git, &base, &conflicts).unwrap();
    let node = oracle(&conflicts);
    assert_eq!(native["kind"], node["kind"]);
    assert_eq!(native["rest"], node["rest"]);
    assert_eq!(native["conflicts"], node["conflicts"]);
    assert_eq!(fs::read(dir.path().join("tracked")).unwrap(), b"original tracked\n");
}

#[test]fn cli_round_metrics_and_report_flags_are_not_silently_ignored(){let(d,g,base)=fixture(json!([assignment("result")]));let before=host(d.path(),&g);let q=call(d.path(),&["round","run","goal","--retry","0","--metrics","--report"],None);let v=value(&q);assert_eq!(v["metrics"].as_array().unwrap().len(),8);assert_eq!(v["report"].as_array().unwrap().len(),3);assert!(v["callLines"].as_array().is_some_and(|a|!a.is_empty()));assert!(v["attribution"].is_array());assert_eq!(v["precheckMerge"]["count"],0);if !q.status.success(){assert_eq!(host(d.path(),&g),before);assert_eq!(g.resolve("refs/heads/main").unwrap(),Some(base));}}
