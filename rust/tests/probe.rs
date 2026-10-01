use fugue::{
    probe,journal::Row
};
use serde_json::{
    Value,json
};
use std::{
    process::{
        Command,Stdio
    },io::Write,path::PathBuf
};
fn row(writer:&str,seq:u64,event:Value)->Row{
    Row{
        writer:writer.into(),seq,event
    }
}
fn call(a:&str,step:&str,inv:u64,cache:Value)->Value{
    json!({
        "t":"llm/call","agent":a,"step":step,"model":"m","toolCount":9,"invocations":inv,"usage":{
            "inputTokens":100,"cacheReadTokens":cache,"cacheWriteTokens":null,"outputTokens":12,"reasoningTokens":null
        },"rawStop":"tool_use","stop":"tool-calls","thinking":"high"
    })
}
fn script()->Vec<Row>{
    vec![row("round",1,json!({
        "t":"round/state","round":"r1","from":"Idle","to":"Planning"
    })),row("a",1,call("agent/r1/1","0",0,json!(0))),row("a",2,json!({
        "t":"prefix/assemble","agent":"agent/r1/1","zoneAHash":"A","zoneBHash":"B","zoneCHash":"C"
    })),row("a",3,json!({
        "t":"mat/fork","paths":["a","b"],"ms":12
    })),row("a",4,json!({
        "t":"run/start","argv":["sh","-c","grep readme"]
    })),row("a",5,json!({
        "t":"mat/reclaim","changed":["a"]
    })),row("a",6,json!({
        "t":"agent/handoff","successor":"agent/r1/2"
    })),row("a",7,call("agent/r1/1","1",1,json!(25))),row("b",1,call("agent/r1/2","0",1,json!(20))),row("b",2,json!({
        "t":"view/write","agent":"agent/r1/2"
    })),row("b",3,json!({
        "t":"ckpt/commit","agent":"agent/r1/2"
    })),row("round",2,json!({
        "t":"round/state","round":"r1","from":"Verifying","to":"Rebuilding"
    })),row("round",3,json!({
        "t":"merge/attempt","round":"r1","conflicts":2
    })),row("round",4,json!({
        "t":"merge/accept","round":"r1","assertions":[{
            "verdict":"pass"
        },{
            "verdict":"fail"
        },{
            "verdict":"unrunnable"
        }]
    })),row("round",5,json!({
        "t":"round/state","round":"r1","from":"Verifying","to":"Working"
    })),row("b",4,json!({
        "t":"run/end","denied":true
    })),row("b",5,json!({
        "t":"bound/deny","rule":"contract-scope"
    })),row("b",6,json!({
        "t":"agent/stop","steps":4,"stopped":"done"
    }))]
}
fn at<'a>(v:&'a Value,id:&str)->&'a Value{
    v.as_array().unwrap().iter().find(|x|x["metric"]==id).unwrap()
}
#[test]fn metrics_are_replayable_and_denominators_are_inspectable(){
    let rows=script();
    let m=probe::metrics(&rows,&json!({
    })).unwrap();
    assert_eq!(m,probe::metrics(&rows,&json!({
    })).unwrap());
    assert_eq!(m.as_array().unwrap().len(),8);
    assert_eq!(at(&m,"zero-tool-call-rate")["value"],json!(1.0/3.0));
    assert_eq!(at(&m,"detour-rate")["value"],1);
    assert_eq!(at(&m,"prefix-hit-rate")["value"],json!(2.0/3.0));
    assert_eq!(at(&m,"prefix-versions")["value"],1);
    assert_eq!(at(&m,"materialize-precision")["value"],2);
    assert_eq!(at(&m,"ensure-latency")["value"],12);
    assert_eq!(at(&m,"handoff-yield")["value"],2);
    for x in m.as_array().unwrap(){
        assert!(x["how"].as_str().unwrap().contains("分子"));
        assert!(x["how"].as_str().unwrap().contains("分母"));
        assert!(probe::metric_line(x).unwrap().contains("分子"));
    }
}
#[test]fn empty_logs_do_not_report_missing_as_zero(){
    let m=probe::metrics(&[],&json!({
    })).unwrap();
    assert!(at(&m,"zero-tool-call-rate")["value"].is_null());
    assert!(at(&m,"zero-tool-call-rate")["numerator"].is_null());
    assert_eq!(at(&m,"prefix-versions")["value"],0);
    assert_eq!(at(&m,"ensure-latency")["detail"],json!({
        "count":0
    }));
    assert_eq!(at(&m,"materialize-precision")["denominator"],0);
    let s=probe::snapshot_of(&[]).unwrap();
    assert_eq!(s["usage"]["calls"],0);
    assert!(s["last"].is_null());
    assert_eq!(probe::attribution(&[]).unwrap().as_array().unwrap().len(),3);
}
#[test]fn prefix_versions_are_per_agent_even_when_events_are_interleaved(){
    let mut rows=vec![];
    for(seq,a)in ["a","b","a","b"].iter().enumerate(){
        rows.push(row(a,seq as u64+1,json!({
            "t":"prefix/assemble","agent":a,"zoneAHash":"A","zoneBHash":a
        })))
    }
    let m=probe::metrics(&rows,&json!({
    })).unwrap();
    assert_eq!(at(&m,"prefix-versions")["value"],2);
    rows.push(row("a",5,json!({
        "t":"prefix/assemble","agent":"a","zoneAHash":"different","zoneBHash":"a"
    })));
    assert_eq!(at(&probe::metrics(&rows,&json!({
    })).unwrap(),"prefix-versions")["value"],3);
}
#[test]fn even_latency_uses_upstream_lower_median_and_scope_keeps_unscoped_rows(){
    let rows=vec![row("a",1,json!({
        "t":"mat/fork","paths":[],"ms":100
    })),row("a",2,json!({
        "t":"mat/sync","paths":[],"ms":2
    })),row("round",1,json!({
        "t":"round/state","round":"other","from":"Idle","to":"Planning"
    }))];
    let m=probe::metrics(&rows,&json!({
        "round":"r1"
    })).unwrap();
    assert_eq!(at(&m,"ensure-latency")["value"],2);
    assert_eq!(at(&m,"git-calls-per-round")["detail"],json!({
        "rounds":0
    }));
}
#[test]fn detour_is_a_word_test_not_a_shell_parser(){
    for(s,b)in [("grep -n TODO",true),("echo readme",false),("sed -n 1,20p",false),("echo bread",false),("echo read",true),("echo pre_read",false),("éreadé",true)]{
        assert_eq!(probe::looks_like_detour(&[s.into()]),b,"{}",s)
    }
}
#[test]fn snapshots_retain_missing_usage_refusals_and_jump_evidence(){
    let s=probe::snapshot_of(&script()).unwrap();
    assert_eq!(s["usage"]["calls"],3);
    assert_eq!(s["usage"]["inputTokens"],json!({
        "total":300,"missing":0
    }));
    assert_eq!(s["usage"]["cacheWriteTokens"],json!({
        "total":0,"missing":3
    }));
    assert_eq!(s["refusals"],json!({
        "total":2,"kernel":1,"byRule":[{
            "rule":"contract-scope","count":1
        }]
    }));
    assert_eq!(s["outside"],json!({
        "rows":1,"paths":["a"]
    }));
    assert_eq!(s["rounds"][0]["hops"],4);
    assert_eq!(s["rounds"][0]["rejects"],1);
    let lines=probe::lines(&s,&json!({
    })).unwrap();
    assert!(lines.iter().any(|x|x.contains("跳步")));
    assert!(lines.iter().any(|x|x.contains("费用 没印")));
}
#[test]fn routes_tolerate_unroutable_known_states_but_reject_unknown_states(){
    assert_eq!(probe::route("Verifying","Rebuilding").unwrap().unwrap().len(),2);
    assert!(probe::route("Aborted","Working").unwrap().is_none());
    assert_eq!(probe::route("Merging","Merging").unwrap().unwrap().len(),0);
    assert!(probe::route("Typo","Working").is_err());
    let s=probe::snapshot_of(&[row("round",1,json!({
        "t":"round/state","round":"r1","from":"Aborted","to":"Working"
    }))]).unwrap();
    assert_eq!(s["rounds"][0]["unrouted"],1);
}
#[test]fn rejection_range_never_claims_to_filter_kernel_denials(){
    let rows=script();
    let counts=probe::counts(&rows,&json!({
        "round":"else"
    })).unwrap();
    assert_eq!(at(&counts,"conflicts")["count"],0);
    assert_eq!(at(&counts,"rejects")["count"],0);
    assert_eq!(at(&counts,"denied")["count"],1);
    assert!(at(&counts,"denied")["how"].as_str().unwrap().starts_with("[整账]"));
    let r=probe::report(&rows,&json!({
        "round":"r1"
    })).unwrap();
    assert_eq!(r["allPositive"],true);
    assert_eq!(r["attributionLines"].as_array().unwrap().len(),3);
    assert_eq!(r["callLines"].as_array().unwrap().len(),4);
}
#[test]fn attribution_uses_numeric_agent_suffixes_and_preserves_missing(){
    let rows=vec![row("a",1,call("agent/r1/10","0",1,Value::Null)),row("a",2,call("agent/r1/2","1",1,json!(7))),row("a",3,call("agent/r1/2","0",1,json!(2)))];
    let a=probe::attribution(&rows).unwrap();
    assert_eq!(a[0]["agent"],"agent/r1/2");
    assert_eq!(a[0]["step"],0);
    assert_eq!(a[1]["agent"],"agent/r1/10");
    assert!(a[1]["cacheReadTokens"].is_null());
    assert_eq!(a[2]["step"],1);
}
#[test]fn malformed_options_events_and_unsafe_totals_fail_closed(){
    assert!(probe::metrics(&[],&Value::Null).is_err());
    assert!(probe::readings_of(&[],&json!({
        "metrics":"yes"
    })).is_err());
    assert!(probe::metrics(&[row("../x",1,json!({
        "t":"event"
    }))],&json!({
    })).is_err());
    assert!(probe::snapshot_of(&[row("a",0,json!({
        "t":"event"
    }))]).is_err());
    for event in [json!({
        "t":"llm/call","invocations":-1
    }),json!({
        "t":"mat/fork","paths":[],"ms":-1
    }),json!({
        "t":"mat/fork","paths":"bad","ms":1
    }),json!({
        "t":"prefix/assemble","agent":"a","zoneAHash":2,"zoneBHash":"b"
    })]{
        assert!(probe::metrics(&[row("a",1,event)],&json!({
        })).is_err());
    }
    let mut rows=vec![];
    for seq in 1..=2{
        let mut c=call("a","0",1,json!(0));
        c["usage"]["inputTokens"]=json!(9_007_199_254_740_991u64);
        rows.push(row("a",seq,c));
    }
    assert!(probe::snapshot_of(&rows).is_err());
}
fn catalog()->Value{
    json!({
        "models":{
            "m":{
                "model":"wire"
            }
        },"prices":[{
            "model":"wire","aliases":[],"peak":{
                "cacheMiss":1,"cacheHit":0.1,"output":2
            },"offPeak":{
                "cacheMiss":0.5,"cacheHit":0.05,"output":1
            }
        }]
    })
}
#[test]fn price_uses_explicit_catalog_and_does_not_double_charge_reasoning(){
    let mut c=call("a","0",1,json!(10));
    c["usage"]["cacheWriteTokens"]=json!(0);
    c["usage"]["reasoningTokens"]=json!(12);
    let rows=vec![row("a",1,c)];
    let options=json!({
        "phase":"peak","cat":catalog()
    });
    let lines=probe::call_lines(&rows,&options).unwrap();
    assert!(lines[0].contains("$0.000125"));
    assert!(lines[1].contains("≈ $0.000125"));
    assert!(probe::call_lines(&rows,&json!({
        "phase":"peak"
    })).is_err());
    assert!(probe::call_lines(&rows,&json!({
        "phase":"wrong","cat":catalog()
    })).is_err());
}
fn oracle(rows:&[Row],options:&Value)->Value{
    let root=std::env::var("FUGUE_UPSTREAM_ROOT").map(PathBuf::from).unwrap_or_else(|_|PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned());
    let script=r#"const fs=await import('node:fs');const up=process.argv[1];const {metricsOf,attributionOf}=await import(up+'/src/probe/metrics.ts');const {countsOf,reportOf}=await import(up+'/src/probe/round.ts');const {statusOf,readingsOf,linesOf,callLinesOf}=await import(up+'/src/probe/status.ts');const {rows,opts}=JSON.parse(fs.readFileSync(0,'utf8'));const cat=opts.cat??{models:{},prices:[]};const lo={cat,...(opts.phase?{phase:opts.phase}:{})};const report=countsOf(rows,opts);console.log(JSON.stringify({metrics:metricsOf(rows,opts),snapshot:statusOf(rows),attribution:attributionOf(rows),counts:report,lines:linesOf(statusOf(rows),lo),callLines:callLinesOf(rows,lo)}));"#;
    let mut c=Command::new("node").args(["--input-type=module","--eval",script]).arg(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("Node 24 explicit differential oracle required");
    let input=json!({
        "rows":rows.iter().map(|r|json!({
            "pos":{
                "writer":r.writer,"seq":r.seq
            },"e":r.event
        })).collect::<Vec<_>>(),"opts":options
    });
    c.stdin.take().unwrap().write_all(serde_json::to_string(&input).unwrap().as_bytes()).unwrap();
    let o=c.wait_with_output().unwrap();
    assert!(o.status.success(),"{}",String::from_utf8_lossy(&o.stderr));
    serde_json::from_slice(&o.stdout).unwrap()
}
#[test]#[ignore="explicit upstream Node 24 differential oracle"]fn all_probe_fields_and_text_match_upstream_exactly(){
    for rows in [vec![],script()]{
        for opts in [json!({
        }),json!({
            "round":"r1"
        }),json!({
            "phase":"peak","cat":catalog()
        })]{
            let up=oracle(&rows,&opts);
            assert_eq!(probe::metrics(&rows,&opts).unwrap(),up["metrics"],"metrics");
            assert_eq!(probe::snapshot_of(&rows).unwrap(),up["snapshot"],"snapshot");
            assert_eq!(probe::attribution(&rows).unwrap(),up["attribution"],"attribution");
            assert_eq!(probe::counts(&rows,&opts).unwrap(),up["counts"],"counts");
            assert_eq!(json!(probe::lines(&probe::snapshot_of(&rows).unwrap(),&opts).unwrap()),up["lines"],"lines");
            assert_eq!(json!(probe::call_lines(&rows,&opts).unwrap()),up["callLines"],"calls");
        }
    }
}
