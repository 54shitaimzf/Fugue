//! Hostile protocol inputs stay offline and fail before any tool dispatch.
use fugue::{assemble, model};
use serde_json::{Value, json};
fn sse(frames: &[Value], done: bool) -> Vec<u8> {
    let mut out = frames.iter().map(|v| format!("data: {v}\n\n")).collect::<String>();
    if done { out.push_str("data: [DONE]\n\n"); }
    out.into_bytes()
}
fn chat(delta: Value, usage: Value) -> Vec<u8> {
    sse(&[json!({"choices":[{"index":0,"delta":delta,"finish_reason":"stop"}]}), json!({"choices":[],"usage":usage})], true)
}
fn request() -> Value { json!({"model":"m","zones":{"A":"policy","B":"goal","C":"tail"}}) }
fn anthropic(message: Value) -> Vec<u8> {
    sse(&[json!({"type":"message_start","message":message}), json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}), json!({"type":"message_stop"})], false)
}
#[test]
fn decoder_error_irreversibly_poisoned_before_finish_or_more_bytes() {
    let valid=chat(json!({"content":"accepted only if no errors"}),Value::Null);
    for bad in [b"data: {broken}\n\n".to_vec(), b"data: \xff\n\n".to_vec(), b"data: {\"choices\":null}\n\n".to_vec()] {
        let mut d=model::Decoder::new("openai-chat").unwrap();
        assert!(d.push(&bad).is_err());
        assert!(d.push(&valid).is_err(),"an ignored earlier parse error cannot rehabilitate a decoder");
        assert!(d.finish().is_err());
    }
    let mut d=model::Decoder::new("openai-chat").unwrap();d.push(&valid).unwrap();
    assert!(d.push(b"data: {}\n\n").is_err());
    assert!(d.finish().is_err(),"a terminal marker does not erase an illegal later frame");
}
#[test]
fn anthropic_envelope_cannot_impersonate_another_role_or_shape() {
    for m in [Value::Null,json!("message"),json!([]),json!({"role":"user"}),json!({"type":"tool_use"}),json!({"content":[{"type":"tool_use","name":"write","input":{}}]})] {
        assert!(model::decode("anthropic-messages",&anthropic(m.clone())).is_err(),"{m}");
    }
    assert!(model::decode("anthropic-messages",&anthropic(json!({"role":"assistant","type":"message","content":[]}))).is_ok());
}
#[test]
fn openai_envelope_rejects_wrong_roles_and_non_function_tools() {
    for delta in [json!({"role":"user"}),json!({"role":false})] {
        assert!(model::decode("openai-chat",&chat(delta.clone(),Value::Null)).is_err(),"{delta}");
    }
    let v=sse(&[json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"custom","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]})],true);
    assert!(model::decode("openai-chat",&v).is_err());
}
#[test]
fn malformed_or_contradictory_usage_never_becomes_billing_truth() {
    for u in [json!({"prompt_tokens_details":false}),json!({"completion_tokens_details":[]}),json!({"prompt_tokens":10,"prompt_cache_hit_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}),json!({"prompt_tokens":10,"prompt_cache_miss_tokens":7,"prompt_cache_hit_tokens":4}),json!({"prompt_tokens":10,"prompt_cache_miss_tokens":11})] {
        assert!(model::decode("openai-chat",&chat(json!({}),u.clone())).is_err(),"{u}");
    }
    let v=sse(&[json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1}}),json!({"choices":[],"usage":{"prompt_cache_hit_tokens":2}})],true);
    assert!(model::decode("openai-chat",&v).is_err(),"usage split across frames must stay consistent");
}
#[test]
fn outbound_requests_never_silently_coerce_malformed_history_or_settings() {
    for field in ["call","promptCache"] { let mut r=request();r[field]=json!(false);for w in ["openai-chat","anthropic-messages"] { assert!(model::encode(w,&r).is_err(),"{field} {w}"); } }
    for (field,value) in [("text",json!(false)),("calls",json!([{"id":4,"name":"read","arguments":"{}"}])),("calls",json!([{"name":"","arguments":"{}"}])),("calls",json!([{"name":"read","arguments":{}}])),("results",json!([{"output":"ok","isError":"false"}]))] {
        let mut r=request();let mut t=json!({"text":"","calls":[{"id":"c","name":"read","arguments":"{}"}],"results":[{"id":"c","output":"ok","isError":false}]});t[field]=value;r["turns"]=json!([t]);
        for w in ["openai-chat","anthropic-messages"] { assert!(model::encode(w,&r).is_err(),"{field} {w}"); }
    }
    for params in [Value::Null,json!([]),json!(false)] {let mut r=request();r["tools"]=json!([{"name":"read","description":"reader","parameters":params}]);assert!(model::encode("openai-chat",&r).is_err());}
}
#[test]
fn assembly_cannot_hide_malformed_turns_or_allocate_unbounded_unused_state() {
    for t in [json!(false),json!({"text":false}),json!({"results":[{"output":{}}]})] { assert!(assemble::from_state(&json!({"turns":[t]}),"holder").is_err()); }
    let v=json!({"unused":vec![Value::Null;100001]});
    assert!(assemble::from_state(&v,"holder").is_err(),"node budget must be checked before clones and formatting");
}
#[test]
fn sse_line_ending_variants_and_split_crlf_are_equivalent() {
    let lf=chat(json!({"content":"line endings 字"}),Value::Null);let reference=model::decode("openai-chat",&lf).unwrap();
    let text=String::from_utf8(lf).unwrap();
    for ending in ["\n","\r\n","\r"] {let bytes=text.replace('\n',ending).into_bytes();for size in [1,2,3,7,31,4096] {let mut d=model::Decoder::new("openai-chat").unwrap();for part in bytes.chunks(size){d.push(part).unwrap();}assert_eq!(d.finish().unwrap(),reference);}}
}
#[test]
fn sse_event_names_and_completion_identity_cannot_be_cross_wired() {
    let a=String::from_utf8(anthropic(json!({}))).unwrap();assert!(model::decode("anthropic-messages",format!("event: error\n{a}").as_bytes()).is_err());
    let a=String::from_utf8(chat(json!({}),Value::Null)).unwrap();assert!(model::decode("openai-chat",format!("event: error\n{a}").as_bytes()).is_err());
    let v=sse(&[json!({"id":"first","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}),json!({"id":"second","choices":[{"index":0,"delta":{"content":"second"},"finish_reason":"stop"}]})],true);
    assert!(model::decode("openai-chat",&v).is_err());
    let v=sse(&[json!({"object":"chat.completion","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})],true);assert!(model::decode("openai-chat",&v).is_err());
}
#[test]
fn history_reasoning_cannot_disappear_or_bypass_validation() {
    let mut r=request();r["turns"]=json!([{"text":"","thinking":{"text":"thought","signature":null},"calls":[],"results":[]}]);
    let b=model::encode("openai-chat",&r).unwrap();let v:Value=serde_json::from_slice(&b).unwrap();assert!(v["messages"].as_array().unwrap().iter().any(|v|v["reasoning_content"]=="thought"));
    for thinking in [json!(false),json!({"text":"ok","signature":false}),json!({"text":false})]{r["turns"][0]["thinking"]=thinking;for w in ["openai-chat","anthropic-messages"]{assert!(model::encode(w,&r).is_err());}}
}
