//! Offline regression cases found during final integration review.
//! No provider requests, real credentials, or host-security changes are used.
use fugue::{assemble, config, git::Git, journal, model, round, session, tools};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};
use std::os::unix::fs::PermissionsExt;
fn repo() -> tempfile::TempDir {
    let d=tempfile::tempdir().unwrap();
    assert!(Command::new("/usr/bin/git").args(["init","-q","-b","main"]).arg(d.path()).status().unwrap().success());
    let g=Git::open(d.path()).unwrap();let t=g.put_tree(&Default::default()).unwrap();let b=g.commit_tree(&t,&[],"base").unwrap();g.advance("refs/heads/main",&b,None).unwrap();d
}
fn request(state:&Value)->Vec<u8> {
    let p=assemble::from_state(state,"holder").unwrap();
    let mut q=json!({"model":"deepseek-flash","zones":{"A":p.a,"B":p.b,"C":p.c},"tools":tools::catalog(),"call":{"thinking":"high","maxTokens":32768}});
    if !state["runtime"].as_str().unwrap_or("").is_empty(){q["cHead"]=state["runtime"].clone()}
    if state["turns"].as_array().is_some_and(|a|!a.is_empty()){q["turns"]=state["turns"].clone()}
    model::encode("anthropic-messages",&q).unwrap()
}
fn initial(root:&Path,opts:&Value,text:&str)->Value {
    let mut o=opts.clone();o["goal"]=json!("");o["protocol"]=json!("holder");o["runtime"]=json!(text);
    let mut state=assemble::initial_state(root,&o).unwrap();
    let archive=session::record_of(&session::archive(root,"r1").unwrap(),"人",text).unwrap();
    state["recent"]=json!(session::recent_of(&archive,3).unwrap());state
}
fn response(chunks:&[String],read:bool)->Vec<u8> {
    let mut a=vec![json!({"type":"message_start","message":{"model":"deepseek-flash","usage":{"input_tokens":30}}})];
    if read {a.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"read","name":"read","input":{"path":"missing"}}}));}
    else {a.push(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}));for text in chunks{a.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}));}}
    a.extend([json!({"type":"content_block_stop","index":0}),json!({"type":"message_delta","delta":{"stop_reason":if read{"tool_use"}else{"end_turn"}},"usage":{"output_tokens":5}}),json!({"type":"message_stop"})]);
    a.iter().map(|v|format!("data: {v}\n\n")).collect::<String>().into_bytes()
}
fn recording(dir:&Path,n:u64,body:&[u8],raw:&[u8]) {
    let p=dir.join(format!("call-{n:04}"));fs::create_dir(&p).unwrap();fs::write(p.join("request.json"),body).unwrap();fs::write(p.join("response.sse"),raw).unwrap();fs::write(p.join("meta.json"),serde_json::to_vec(&json!({"requestHash":assemble::hash(body)})).unwrap()).unwrap();
}
#[test]
fn same_idle_message_preserves_cumulative_cap_and_resumes_the_identical_session() {
    let d=repo();let w=tempfile::tempdir().unwrap();let o=json!({"wire-in":w.path(),"max-steps":1});let text="same request";
    recording(w.path(),1,&request(&initial(d.path(),&o,text)),&response(&[],true));
    let first=round::say(d.path(),&[text.into()],&o).unwrap();assert_eq!(first["driver"]["stopped"],"max-steps");
    let before=journal::read(d.path(),"round").unwrap();
    let second=round::say(d.path(),&[text.into()],&o).unwrap();assert_eq!(second["driver"]["stopped"],"max-steps");assert_eq!(second["driver"]["session"],first["driver"]["session"]);
    let after=journal::read(d.path(),"round").unwrap();
    assert_eq!(after.iter().filter(|r|r.event["t"]=="runtime/start").count(),1);
    assert_eq!(after.iter().filter(|r|r.event["t"]=="runtime/request").count(),1);
    assert_eq!(session::records_of(&session::archive(d.path(),"r1").unwrap()).unwrap()["records"].as_array().unwrap().len(),1);
    let start=before.iter().find(|r|r.event["t"]=="runtime/start").unwrap();let step=before.iter().find(|r|r.event["t"]=="runtime/step").unwrap();
    let mut state=start.event["state"].clone();state["turns"]=json!([step.event["turn"]]);state["lastStep"]=step.event["lastStep"].clone();state["runtime"]=json!(model::step_notice(&state,2,1).unwrap());state["currentCap"]=json!(2);
    recording(w.path(),2,&request(&state),&response(&["finished".into()],false));
    let mut raised=o.clone();raised["max-steps"]=json!(2);let done=round::say(d.path(),&[text.into()],&raised).unwrap();assert_eq!(done["driver"]["done"],true,"{done}");assert_eq!(done["driver"]["session"],first["driver"]["session"]);assert_eq!(done["records"],2);assert_eq!(done["distill"],"finished");
    assert_eq!(journal::read(d.path(),"round").unwrap().iter().filter(|r|r.event["t"]=="runtime/start").count(),1);
}
#[test]
fn doctor_cannot_run_path_shadow_commands_or_print_inherited_secrets() {
    let d=repo();let b=d.path().join("fake-bin");fs::create_dir(&b).unwrap();let marker=d.path().join("doctor-side-effect");
    for name in ["git","bwrap"] {let p=b.join(name);fs::write(&p,format!("#!/bin/sh\nprintf forbidden > '{}'\nprintf '%s\\n' \"$FUGUE_REVIEW_SECRET\"\n",marker.display())).unwrap();fs::set_permissions(&p,fs::Permissions::from_mode(0o755)).unwrap();}
    let q=Command::new(env!("CARGO_BIN_EXE_fugue")).arg("--root").arg(d.path()).args(["--json","doctor"]).env("PATH",format!("{}:/usr/bin:/bin",b.display())).env("FUGUE_REVIEW_SECRET","test-only-secret").env("FUGUE_SYSTEM_DIR",d.path().join("missing-system")).output().unwrap();
    assert!(q.status.success(),"{}",String::from_utf8_lossy(&q.stderr));assert!(!marker.exists());assert!(!q.stdout.windows(b"test-only-secret".len()).any(|b|b==b"test-only-secret"));
    let v:Value=serde_json::from_slice(&q.stdout).unwrap();assert!(v["git"].as_str().unwrap().starts_with("git version "));assert!(v["bwrap"].as_str().unwrap().starts_with("bubblewrap "));
}
#[test]
fn approval_rejects_a_digest_valid_draft_with_a_corrupt_version_chain() {
    let d=repo();config::set(d.path(),"actions.ok",r#"{"argv":["/usr/bin/true"]}"#,false).unwrap();config::set(d.path(),"round.split",r#"[{"goal":"write out","ownedPaths":["out"],"assertions":[{"name":"ok","action":"ok"}]}]"#,false).unwrap();
    let p=round::command(d.path(),"plan",&["goal".into()],&json!({})).unwrap();
    journal::append(d.path(),"round",json!({"t":"holder/distill","round":"r1","agent":"round","body":p["draft"],"digest":p["version"]["digest"],"against":"bogus"})).unwrap();
    assert!(session::versions(d.path(),"r1").is_err());let before=journal::read(d.path(),"round").unwrap();assert!(round::command(d.path(),"go",&[],&json!({})).is_err());assert_eq!(journal::read(d.path(),"round").unwrap(),before);assert!(Git::open(d.path()).unwrap().resolve("refs/heads/agent/r1/1").unwrap().is_none());
}
#[test]
fn oversized_completed_reply_refuses_all_projection_effects_and_does_not_repeat_model_call() {
    let d=repo();let w=tempfile::tempdir().unwrap();let o=json!({"wire-in":w.path(),"max-steps":1});let text="hello";
    recording(w.path(),1,&request(&initial(d.path(),&o,text)),&response(&["x".repeat(600_000),"x".repeat(600_000)],false));
    for _ in 0..2 {let error=round::say(d.path(),&[text.into()],&o).unwrap_err();assert!(error.message.contains("archive bounds"));assert!(session::versions(d.path(),"r1").unwrap().as_array().unwrap().is_empty());assert_eq!(session::records_of(&session::archive(d.path(),"r1").unwrap()).unwrap()["records"].as_array().unwrap().len(),1);}
    let rows=journal::read(d.path(),"round").unwrap();assert!(rows.iter().any(|r|r.event["t"]=="session/end"&&r.event["done"]==true));assert_eq!(rows.iter().filter(|r|r.event["t"]=="runtime/start").count(),1);assert_eq!(rows.iter().filter(|r|r.event["t"]=="runtime/request").count(),1);
}
#[test]
fn idempotent_holder_finish_repairs_a_complete_landing_prefix_without_duplicate_versions() {
    let d=repo();session::append(d.path(),"r1","user","hello").unwrap();
    let finished=session::finish(d.path(),"r1","answer","round/fixture").unwrap();assert_eq!(finished["version"],1);
    let log=d.path().join(".fugue/log/round.jsonl");let bytes=fs::read(&log).unwrap();
    let rows=journal::read(d.path(),"round").unwrap();let landing=rows.iter().position(|r|r.event["t"]=="holder/distill").unwrap();
    let boundary=bytes.split_inclusive(|b|*b==b'\n').take(landing+1).map(|s|s.len()).sum::<usize>();fs::write(&log,&bytes[..boundary]).unwrap();
    assert_eq!(session::versions(d.path(),"r1").unwrap().as_array().unwrap().len(),1);assert_eq!(session::records_of(&session::archive(d.path(),"r1").unwrap()).unwrap()["records"].as_array().unwrap().len(),1);
    let repaired=session::finish(d.path(),"r1","answer","round/fixture").unwrap();assert_eq!(repaired["digest"],finished["digest"]);
    let before=journal::read(d.path(),"round").unwrap();session::finish(d.path(),"r1","answer","round/fixture").unwrap();assert_eq!(journal::read(d.path(),"round").unwrap(),before);
    assert_eq!(session::versions(d.path(),"r1").unwrap().as_array().unwrap().len(),1);assert_eq!(session::records_of(&session::archive(d.path(),"r1").unwrap()).unwrap()["records"].as_array().unwrap().len(),2);
    assert!(session::finish(d.path(),"r1","changed body","round/fixture").is_err());
}
#[test]
fn missing_live_credential_is_rejected_before_any_transmission_intent() {
    let d=repo();let outside=tempfile::tempdir().unwrap();let missing=outside.path().join("guaranteed-missing");
    config::set(d.path(),"credentials.deepseek",&json!([{"from":"file","path":missing}]).to_string(),false).unwrap();
    let o=json!({"live":true,"max-steps":1,"goal":"pre-send credential validation"});
    // A missing-only reference chain cannot reach the live transport or send.
    for _ in 0..2 {assert!(model::drive(d.path(),"agent/key-test",&o).unwrap_err().message.contains("credential"));}
    let rows=journal::read(d.path(),"agent/key-test").unwrap();assert!(rows.iter().all(|r|r.event["t"]!="runtime/request"&&r.event["t"]!="llm/attempt"));
}
#[test]
fn approval_never_reuses_a_valid_idle_understanding_from_before_current_planning_phase(){let d=repo();config::set(d.path(),"actions.ok",r#"{"argv":["/usr/bin/true"]}"#,false).unwrap();let body=r#"```json
{"kind":"implement","goal":"write out","ownedPaths":["out"],"deliverables":[],"assertions":[{"name":"ok","action":"ok"}],"seed":[]}
```"#;session::land(d.path(),"r1",body).unwrap();let base=Git::open(d.path()).unwrap().resolve("main").unwrap().unwrap();let intent=json!({"goal":"goal"}).to_string();journal::append(d.path(),"round",json!({"t":"round/intent","round":"r1","base":base,"body":intent,"digest":assemble::hash(intent.as_bytes())})).unwrap();journal::append(d.path(),"round",json!({"t":"round/state","round":"r1","from":"Idle","to":"Planning"})).unwrap();let before=journal::read(d.path(),"round").unwrap();let error=round::command(d.path(),"go",&[],&json!({})).unwrap_err();assert!(error.message.contains("current Planning phase"));assert_eq!(journal::read(d.path(),"round").unwrap(),before);assert!(Git::open(d.path()).unwrap().resolve("refs/heads/agent/r1/1").unwrap().is_none());}
