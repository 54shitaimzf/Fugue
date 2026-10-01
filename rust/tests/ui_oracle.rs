//! Explicit, read-only differential checks against the fetched upstream 0.2.3.
//! Product code never invokes Node. No Node test runner IPC is involved.
use fugue::ui::{self,Editor,Key};
use serde_json::{Value,json};
use sha2::{Sha256,Digest};
use std::{io::Write,path::Path,process::{Command,Stdio}};
const UPSTREAM:&str="633a6b2fb63da459074f1077f92ac8fbfc839416";
fn sources()->tempfile::TempDir {
    let dir=tempfile::tempdir().unwrap();
    let fixture=Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oracle/633a6b2");
    for (name,hash) in [("input.ts","ebd8224ca57aa2aa31ae31f74d121bee7d80839ed6e7bfb0bcfeb5866261f4d3"),("glyph.ts","f6f5f153245587104aa39526246a52bb7eeabf8403baa196f8e0cc55484e49fa")] {
        let bytes=std::fs::read(fixture.join(name)).unwrap();
        assert_eq!(format!("{:x}",Sha256::digest(&bytes)),hash,"immutable upstream {UPSTREAM} oracle {name}");
        std::fs::write(dir.path().join(name),bytes).unwrap();
    }
    dir
}
fn run_oracle(input:&Value)->Value {
    let dir=sources();
    let script=r#"import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const {emptyEditor,applyIntent,inputFrameOf,submitOf}=await import(pathToFileURL(process.argv[1]+'/input.ts'));const cases=JSON.parse(readFileSync(0,'utf8'));const out=cases.map(c=>{let e=emptyEditor();if(c.operations){for(const op of c.operations)e=applyIntent(e,op)}else{e=applyIntent(e,{t:'insert',text:c.text});e={...e,unfolded:c.unfolded,draft:{...e.draft,caret:Buffer.from(c.text).subarray(0,c.at).toString('utf8').length}}}return {frame:inputFrameOf({e,prompt:c.prompt,width:c.width,rows:c.rows}),text:submitOf(e)}});console.log(JSON.stringify(out));"#;
    let mut child=Command::new("node").args(["--input-type=module","--eval",script]).arg(dir.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let body=serde_json::to_vec(input).unwrap();
    let mut stdin=child.stdin.take().unwrap();
    let writer=std::thread::spawn(move||stdin.write_all(&body));
    let out=child.wait_with_output().unwrap(); writer.join().unwrap().unwrap();
    assert!(out.status.success(),"{}",String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]#[ignore="explicit latest upstream Node 24 input/glyph differential oracle"]
fn latest_wrapping_and_caret_matrix_matches_exact_upstream_commit() {
    let mut cases=Vec::new(); let mut expected=Vec::new();
    let samples=vec!["".into(),"abc".into(),"abcd".into(),"abc中z".into(),"abc👨‍👩‍👧z".into(),"abc🇨🇳z".into(),"abc👍🏽z".into(),"e\u{301}中文".into(),"\u{301}abc中文".into(),"a\tb\n中".into(),"x\x1b[2J\r\x03\x7f".into()," abc  中文 👨‍👩‍👧 e\u{301} 🇨🇳 👍🏽 ".repeat(15),"x".repeat(600)];
    for text in samples {
        let mut at=vec![0,text.len()];
        at.extend(text.char_indices().take(8).map(|(n,_)|n)); at.sort_unstable(); at.dedup();
        for at in at { for width in [1,2,3,4,6,7,12,80] { for rows in [1,3,1000] { for prompt in ["","> "] { for unfolded in [false,true] {
            let mut e=Editor::default(); e.apply(&Key::Text(text.clone())).unwrap(); e.at=at; e.unfolded=unfolded;
            expected.push(json!({"frame":ui::input_frame(&e,prompt,width,rows).unwrap(),"text":text}));
            cases.push(json!({"text":text,"at":at,"width":width,"rows":rows,"prompt":prompt,"unfolded":unfolded}));
        }}}}}
    }
    let actual=run_oracle(&json!(cases)); let actual=actual.as_array().unwrap();
    assert_eq!(actual.len(),expected.len());
    for (i,(actual,expected)) in actual.iter().zip(expected).enumerate() { assert_eq!(*actual,expected,"case {i}: {}",cases[i]); }
}
#[test]#[ignore="explicit latest upstream Node 24 folded editing differential oracle"]
fn folded_edits_undo_redo_and_projection_match_exact_upstream_commit() {
    let operations=[
        (Key::Text("before ".into()),json!({"t":"insert","text":"before "})),
        (Key::Paste("a\nb\nc\nd\ne".into()),json!({"t":"insert","text":"a\nb\nc\nd\ne"})),
        (Key::Text(" after".into()),json!({"t":"insert","text":" after"})),
        (Key::ToggleFold,json!({"t":"toggleFold"})),
        (Key::ToggleFold,json!({"t":"toggleFold"})),
        (Key::Home,json!({"t":"home"})),
        (Key::Text("prefix ".into()),json!({"t":"insert","text":"prefix "})),
        (Key::End,json!({"t":"end"})),
        (Key::Left,json!({"t":"left"})),
        (Key::Backspace,json!({"t":"backspace"})),
        (Key::Undo,json!({"t":"undo"})),
        (Key::Redo,json!({"t":"redo"})),
        (Key::Home,json!({"t":"home"})),
        (Key::KillStart,json!({"t":"killToStart"})),
        (Key::Undo,json!({"t":"undo"})),
    ];
    let mut e=Editor::default(); let mut prefix=Vec::new(); let mut cases=Vec::new(); let mut expected=Vec::new();
    for (key,operation) in operations { e.apply(&key).unwrap(); prefix.push(operation); for width in [6,20,80] {
        cases.push(json!({"operations":prefix,"prompt":"> ","width":width,"rows":3}));
        expected.push(json!({"frame":ui::input_frame(&e,"> ",width,3).unwrap(),"text":e.text}));
    }}
    let actual=run_oracle(&json!(cases));
    for (i,(actual,expected)) in actual.as_array().unwrap().iter().zip(expected).enumerate() { assert_eq!(*actual,expected,"sequence {i}: {}",cases[i]); }
}
