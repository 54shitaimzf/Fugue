use fugue::{contracts,git::{Entry,Git}};
use serde_json::{Value,json};
use std::{collections::BTreeMap,io::Write,path::{Path,PathBuf},process::{Command,Stdio}};
fn repository(files:&[(&str,&[u8])])->(tempfile::TempDir,String) {
    let dir=tempfile::tempdir().unwrap();
    assert!(Command::new("git").args(["init","-q","--initial-branch=main"]).arg(dir.path()).status().unwrap().success());
    let git=Git::open(dir.path()).unwrap();
    let mut tree=BTreeMap::new();
    for (path,bytes) in files {
        tree.insert((*path).into(),Entry {kind:"file".into(),mode:0o100644,id:git.put_blob(bytes).unwrap()});
    }
    let base=git.commit_tree(&git.put_tree(&tree).unwrap(),&[],"pinned contract fixture").unwrap();
    git.advance("refs/heads/main",&base,None).unwrap();
    (dir,base)
}
fn cfg()->Value {json!({"round":{"model":"m"},"actions":{"check":{"argv":["/usr/bin/true"],"outputs":[]},"build":{"argv":["make"],"outputs":["src/generated"]}}})}
fn catalog(limit:u64,margin:u64)->Value {json!({"defaultModel":"m","models":{"m":{"contextLimit":limit,"budget":{"handoffMargin":margin}}}})}
fn assignment(goal:&str,path:&str,seed:Value)->Value {json!({"kind":"implement","goal":goal,"ownedPaths":[path],"deliverables":[{"path":path,"form":"module"}],"assertions":[{"action":"check","name":"tests"}],"seed":seed})}
fn fence(v:&Value)->String {format!("```json\n{}\n```",serde_json::to_string(v).unwrap())}
fn built(path:&Path,base:&str,raw:&Value)->Value {contracts::build_with_catalog(path,&cfg(),&catalog(1_000_000,16_000),"r1",base,&json!({"goal":"whole goal"}),raw).unwrap()}
#[test]
fn investigate_comes_first_but_ids_count_per_variant() {
    let (dir,base)=repository(&[("src/input",b"pinned input")]);
    let investigation=json!({"kind":"investigate","question":"What is the current behavior?","evidenceRequired":[{"note":"current-state"}],"seed":["src/input"]});
    let implementation=assignment("implement behavior","src/result",json!(["src/input"]));
    let raw=json!(format!("{}\n\n{}",fence(&investigation),fence(&implementation)));
    let result=built(dir.path(),&base,&raw);
    assert_eq!(result["counts"],json!({"implement":1,"investigate":1,"resolve":0}));
    assert_eq!(result["contracts"][0]["id"],"r1.investigate.1");
    assert_eq!(result["contracts"][1]["id"],"r1.implement.1");
    assert_eq!(result["contracts"][1]["agent"],"agent/r1/2");
    assert_eq!(result["contracts"][1]["branch"],"refs/heads/agent/r1/2");
    assert_eq!(result["contracts"][0]["goal"],"whole goal");
    assert_eq!(result["contracts"][0]["evidenceRequired"],json!([{"artifact":"evidence/agent/r1/1/current-state","note":"current-state"}]));
    assert_eq!(result["seedRead"]["loaded"],1);
    assert!(!dir.path().join(".fugue").exists());
    assert!(!dir.path().join("src").exists());
}
#[test]
fn seeds_measure_pinned_content_not_current_host_files_or_only_pointers() {
    let contents=b"a moderately sized seed from the pinned tree";
    let (dir,base)=repository(&[("seed",contents)]);
    std::fs::write(dir.path().join("seed"),b"host content must not change the budget").unwrap();
    let result=built(dir.path(),&base,&json!([assignment("change","output",json!(["seed","seed"]))]));
    let text=format!("seed\nseed\n{}\n{}",std::str::from_utf8(contents).unwrap(),std::str::from_utf8(contents).unwrap());
    assert_eq!(result["seedTokens"],json!([fugue::assemble::estimate(text.as_bytes())]));
    assert_eq!(result["seedRead"]["loaded"],1);
    assert_eq!(result["seedRead"]["missing"],json!([]));
    assert_eq!(std::fs::read(dir.path().join("seed")).unwrap(),b"host content must not change the budget");
}
#[test]
fn declared_model_budget_and_explicit_narrowing_refuse_overflow_without_truncation() {
    let (dir,base)=repository(&[("large",&vec![b'x';1000])]);
    let raw=json!([assignment("change","output",json!(["large"]))]);
    let cat=catalog(1000,100);
    let cfg=cfg();
    let result=contracts::build_with_catalog(dir.path(),&cfg,&cat,"r1",&base,&json!({"goal":"whole"}),&raw).unwrap();
    assert_eq!(result["seedLimit"],820);
    assert_eq!(result["seedBudget"]["zoneA"],80);
    let mut narrow=cfg.clone(); narrow["round"]["seedLimit"]=json!(100);
    assert!(contracts::build_with_catalog(dir.path(),&narrow,&cat,"r1",&base,&json!({"goal":"whole"}),&raw).unwrap_err().message.contains("without truncation"));
    narrow["round"]["seedLimit"]=json!(821);
    assert!(contracts::build_with_catalog(dir.path(),&narrow,&cat,"r1",&base,&json!({"goal":"whole"}),&raw).is_err());
    assert!(contracts::build_with_catalog(dir.path(),&cfg,&catalog(100,99),"r1",&base,&json!({"goal":"whole"}),&raw).is_err());
    assert!(!dir.path().join(".fugue").exists());
}
#[test]
fn missing_binary_directory_and_invalid_base_seed_data_fail_closed() {
    let (dir,base)=repository(&[("dir/file",b"content"),("binary",b"\xff\xfe")]);
    for seed in ["missing","dir","binary"] {
        let raw=json!([assignment("change","output",json!([seed]))]);
        assert!(contracts::build_with_catalog(dir.path(),&cfg(),&catalog(1_000_000,16_000),"r1",&base,&json!({"goal":"whole"}),&raw).is_err(),"seed {seed}");
    }
    let git=Git::open(dir.path()).unwrap();let blob=git.put_blob(b"not a commit").unwrap();
    assert!(contracts::build_with_catalog(dir.path(),&cfg(),&catalog(1_000_000,16_000),"r1",&blob,&json!({"goal":"whole"}),&json!([])).is_err());
}
#[test]
fn action_outputs_and_deliverables_must_fit_the_declared_scope() {
    let (dir,base)=repository(&[]);
    let mut a=assignment("generate","src",json!([]));
    a["assertions"]=json!([{"name":"build output","action":"build","where":"src","expect":0}]);
    let result=built(dir.path(),&base,&json!([a.clone()]));
    assert_eq!(result["contracts"][0]["actionOutputs"],json!({"build":["src/generated"]}));
    a["ownedPaths"]=json!(["src/other"]);a["deliverables"]=json!([]);
    assert!(contracts::build_with_catalog(dir.path(),&cfg(),&catalog(1_000_000,16_000),"r1",&base,&json!({"goal":"whole"}),&json!([a])).is_err());
    let mut a=assignment("wrong deliverable","owned",json!([]));a["deliverables"][0]["path"]=json!("elsewhere");
    assert!(contracts::build_with_catalog(dir.path(),&cfg(),&catalog(1_000_000,16_000),"r1",&base,&json!({"goal":"whole"}),&json!([a])).is_err());
}
#[test]
fn draft_key_domains_order_evidence_and_expectations_are_strict() {
    let valid=assignment("change","src/x",json!([]));
    for bad in [json!({"kind":"resolve"}),json!({"kind":"implement","goal":"x","ownedPaths":["x"],"assertions":[]}),json!({"kind":"investigate","question":"why","evidenceRequired":[{"note":"../escape"}],"seed":[]})] {
        assert!(contracts::draft(&fence(&bad)).is_err());
    }
    let mut bad=valid.clone();bad["agent"]=json!("chosen-by-draft");assert!(contracts::draft(&fence(&bad)).is_err());
    let mut bad=valid.clone();bad["seed"]=json!(["evidence/agent/r1/1/current-state"]);assert!(contracts::draft(&fence(&bad)).is_err());
    let mut bad=valid.clone();bad["assertions"][0]["expect"]=json!(256);assert!(contracts::draft(&fence(&bad)).is_err());
    let investigation=json!({"kind":"investigate","question":"why","evidenceRequired":[{"note":"notes"}],"seed":[]});
    assert!(contracts::draft(&format!("{}\n{}",fence(&valid),fence(&investigation))).is_err());
    assert!(contracts::draft(&format!("{}\n{}",fence(&investigation),fence(&investigation))).is_err());
    assert!(contracts::draft("```json\n{\"kind\":\"implement\",\"kind\":\"investigate\"}\n```").is_err());
}
#[test]
fn parsed_draft_matches_normalized_sections_and_ignores_only_prose() {
    let (dir,base)=repository(&[]);
    let raw=format!("# Plan\nA reason\n{}\n\n\nEnd",fence(&assignment("change","x",json!([]))));
    let parsed=contracts::draft(&raw).unwrap();
    assert_eq!(parsed["prose"],"A reason\n\nEnd");
    assert_eq!(built(dir.path(),&base,&json!(raw)),built(dir.path(),&base,&parsed));
    let mut bad=parsed.clone();bad["split"][0]["goal"]=json!("tampered");
    assert!(contracts::build_with_catalog(dir.path(),&cfg(),&catalog(1_000_000,16_000),"r1",&base,&json!({"goal":"whole goal"}),&bad).is_err());
}
#[test]
fn programmatic_intent_investigation_offsets_identity_and_seed_slots() {
    let (dir,base)=repository(&[("first",b"investigation"),("second",b"implementation")]);
    let mut cfg=cfg();cfg["round"]["seeds"]=json!([["first"],["second"]]);
    let mut a=assignment("change","x",json!([]));a.as_object_mut().unwrap().remove("seed");
    let result=contracts::build_with_catalog(dir.path(),&cfg,&catalog(1_000_000,16_000),"r1",&base,&json!({"goal":"whole","question":"why","evidenceRequired":[{"note":"notes"}]}),&json!([a])).unwrap();
    assert_eq!(result["contracts"][0]["seed"],json!(["first"]));
    assert_eq!(result["contracts"][1]["seed"],json!(["second"]));
    assert_eq!(result["contracts"][1]["agent"],"agent/r1/2");
}
#[test]
fn precheck_preserves_self_and_cross_intersections_as_report_only() {
    let contracts=vec![json!({"kind":"implement","id":"r1.implement.1","ownedPaths":["src","src/parse"]}),json!({"kind":"implement","id":"r1.implement.2","ownedPaths":["src/parse/file","src/parser"]}),json!({"kind":"investigate","id":"r1.investigate.1","agent":"agent/r1/3"})];
    let result=contracts::precheck(&contracts).unwrap();
    assert_eq!(result["intersections"].as_array().unwrap().len(),2);
    assert_eq!(result["intersections"][0]["self"],true);
    assert_eq!(result["intersections"][1]["hits"].as_array().unwrap().len(),3);
    assert!(result["lines"][1].as_str().unwrap().contains("implement × implement"));
    assert!(!contracts::covers("src/parse","src/parser"));
    assert!(contracts::covers("src/parse","src/parse/file"));
    assert!(contracts::precheck(&[json!({"kind":"implement","id":"same","ownedPaths":["x"]}),json!({"kind":"implement","id":"same","ownedPaths":["y"]})]).is_err());
}
#[test]
fn generated_resolve_uses_exact_conflict_base_paths_owner_and_assertions() {
    let (dir,base)=repository(&[]);
    let c=contracts::resolve(dir.path(),&cfg(),"r1",&base,&["src/file".into()],&json!([{"action":"check","name":"resolved","where":"src","expect":0}]),"agent/r1/resolve").unwrap();
    assert_eq!(c["kind"],"resolve");assert_eq!(c["id"],"r1.resolve.1");assert_eq!(c["branch"],"refs/heads/agent/r1/resolve");assert_eq!(c["base"],base);assert_eq!(c["conflictPaths"],json!(["src/file"]));assert!(c.get("ownedPaths").is_none());assert!(c.get("seed").is_none());
    for paths in [vec![],vec!["evidence/notes".into()],vec!["x".into(),"x".into()]] {
        assert!(contracts::resolve(dir.path(),&cfg(),"r1",&base,&paths,&json!([{"action":"check","name":"resolved"}]),"agent/r1/resolve").is_err());
    }
    assert!(contracts::resolve(dir.path(),&cfg(),"r1",&base,&["x".into()],&json!([]),"agent/r1/resolve").is_err());
    assert!(contracts::resolve(dir.path(),&cfg(),"r1",&base,&["x".into()],&json!([{"action":"check","name":"resolved"}]),"agent/other/resolve").is_err());
}
#[test]
fn hostile_paths_bindings_and_work_budgets_refuse_without_writes() {
    let (dir,base)=repository(&[]);let cat=catalog(1_000_000,16_000);let goal=json!({"goal":"whole"});
    for path in ["../escape",".git/config",".fugue/log","evidence","evidence/notes","x/","x//y",""] {
        assert!(contracts::build_with_catalog(dir.path(),&cfg(),&cat,"r1",&base,&goal,&json!([assignment("bad",path,json!([]))])).is_err(),"{path}");
    }
    for assertion in [json!({"name":"bad","action":"missing"}),json!({"name":"bad","action":"check","expect":-1}),json!({"name":"bad","action":"check","where":"../escape"}),json!({"name":"bad","action":"check","argv":["sh"]})] {
        let mut a=assignment("bad","x",json!([]));a["assertions"]=json!([assertion]);assert!(contracts::build_with_catalog(dir.path(),&cfg(),&cat,"r1",&base,&goal,&json!([a])).is_err());
    }
    for bad in [json!({"argv":[]}),json!({"argv":["ok"],"cwd":true}),json!({"argv":["ok"],"outputs":"bad"}),json!({"argv":["ok"],"outputs":["../escape"]})] {
        let mut cfg=cfg();cfg["actions"]["check"]=bad;assert!(contracts::build_with_catalog(dir.path(),&cfg,&cat,"r1",&base,&goal,&json!([assignment("bad","x",json!([]))])).is_err());
    }
    let large=json!({"kind":"implement","id":"r1.implement.1","ownedPaths":(0..2000).map(|n|format!("x{n}")).collect::<Vec<_>>()});
    assert!(contracts::precheck(&[large]).is_err());
    assert!(!dir.path().join(".fugue").exists());
}
fn oracle(path:&Path,base:&str,cfg:&Value,raw:&Value)->Value {
    let upstream=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
    let source=r#"const fs=await import('node:fs');const up=process.argv[1];const {gateOf}=await import(up+'/src/contract/gate.ts');const {draftOf}=await import(up+'/src/contract/draft.ts');const {precheck}=await import(up+'/src/contract/precheck.ts');const {seedRulerAt}=await import(up+'/src/round/seed.ts');const {identFor}=await import(up+'/src/identity.ts');const {openTruth}=await import(up+'/src/truth/truth.ts');const {readBinding}=await import(up+'/src/boundary/binding.ts');const {path,base,cfg,raw}=JSON.parse(fs.readFileSync(0,'utf8'));let intent={goal:'whole goal'};const actions=Object.fromEntries(Object.keys(cfg.actions).map(k=>[k,readBinding(cfg,k).outputs]));const truth=openTruth(path);const ruler=seedRulerAt(truth,base);let inp,parsed=null,seeds=[];if(typeof raw==='string'){parsed=draftOf(raw);inp={from:'draft',text:raw,goal:intent.goal};seeds=parsed.seeds;}else{const split=raw.map(({kind,seed,...rest})=>rest);seeds=raw.map(x=>x.seed??[]);inp={from:'split',intent,split,seeds};}const deps={round:'r1',base,identityFor:n=>identFor('r1',n),actions,seedRuler:ruler,modelLimit:1000000,actionOutputsOf:n=>Object.fromEntries((raw[n]?.assertions??[]).filter(a=>actions[a.action]?.length).map(a=>[a.action,actions[a.action]]))};const gate=await gateOf(inp,deps);await truth.close();console.log(JSON.stringify({draft:parsed,built:gate.built,precheck:gate.precheck,seedRead:ruler.reading,held:gate.held,problems:gate.problems}));"#;
    let mut child=Command::new("node").args(["--input-type=module","--eval",source]).arg(upstream).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("explicit Node 24 differential oracle required");
    child.stdin.take().unwrap().write_all(serde_json::to_string(&json!({"path":path,"base":base,"cfg":cfg,"raw":raw})).unwrap().as_bytes()).unwrap();
    let output=child.wait_with_output().unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
#[ignore="explicit upstream Node 24 differential oracle"]
fn draft_build_precheck_and_actual_seed_budget_match_upstream() {
    let (dir,base)=repository(&[("seed",b"pinned contents")]);
    let implementation=assignment("change","src/x",json!(["seed"]));
    let investigation=json!({"kind":"investigate","question":"current state?","evidenceRequired":[{"note":"notes"}],"seed":["seed"]});
    for raw in [json!([implementation.clone()]),json!(fence(&implementation)),json!(format!("# Plan\nReason\n{}\n{}",fence(&investigation),fence(&implementation)))] {
        let upstream=oracle(dir.path(),&base,&cfg(),&raw);
        assert_eq!(upstream["held"],true);
        let result=built(dir.path(),&base,&raw);
        for field in ["contracts","counts","seedLimit","seedTokens"] {assert_eq!(result[field],upstream["built"][field],"{field}");}
        assert_eq!(result["precheck"],upstream["precheck"]);
        for field in ["from","loaded","missing"] {assert_eq!(result["seedRead"][field],upstream["seedRead"][field],"seedRead.{field}");}
        if let Some(text)=raw.as_str() {assert_eq!(contracts::draft(text).unwrap(),upstream["draft"]);}
    }
}
