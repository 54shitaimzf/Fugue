use fugue::{
    ui,probe,journal::{
        self,Row
    }
};
use serde_json::json;
use std::{
    collections::BTreeMap,process::{
        Command,Child,Stdio
    },fs::File,io::{
        Read,Write
    },os::fd::{
        AsRawFd,FromRawFd
    },time::{
        Duration,Instant
    }
};
fn row(w:&str,n:u64)->Row{
    Row{
        writer:w.into(),seq:n,event:json!({
            "t":"signal","agent":w
        })
    }
}
#[test]fn frame_dimensions_and_controls_are_bounded(){
    let v=probe::readings_of(&[],&json!({
        "metrics":true,"report":true
    })).unwrap();
    for(w,h)in [(4,5),(20,12),(80,24),(1000,100),(1,1)]{
        let f=ui::frame(&v,&json!({
            "width":w,"height":h,"input":"evil\u{1b}[2J\r\n\u{202e}"
        })).unwrap();
        assert!(f.len()<=h);
        for l in f{
            assert!(ui::width(&l)<=w);
            assert!(!l.contains('\u{1b}'));
            assert!(!l.contains('\r'));
            assert!(!l.contains('\n'));
        }
    }
    for o in [json!({
        "width":0
    }),json!({
        "height":-1
    }),json!({
        "width":1001
    }),json!({
        "width":1000,"height":1000
    }),json!({
        "scroll":-1
    })]{
        assert!(ui::frame(&v,&o).is_err());
    }
}
#[test]fn unknown_escape_sequences_cannot_trigger_approval_or_typing(){
    let mut d=ui::Decoder::default();
    assert!(d.push(b"\x1b[",false).unwrap().is_empty());
    assert!(d.push(b"999g",false).unwrap().is_empty());
    assert_eq!(d.push(b"g",false).unwrap(),vec![ui::Key::Text("g".into())]);
    assert!(d.push(b"\x1b",false).unwrap().is_empty());
    assert_eq!(d.push(b"",true).unwrap(),vec![ui::Key::Esc]);
    let long=[b"\x1b[".to_vec(),vec![b'1';
    65]].concat();
    assert!(ui::Decoder::default().push(&long,false).is_err());
}
#[test]fn bracketed_paste_is_an_atomic_insert_including_newlines_and_control_keys(){
    let mut d=ui::Decoder::default();
    assert!(d.push(b"\x1b[20",false).unwrap().is_empty());
    assert!(d.push(b"0~g\ry\x03\n",false).unwrap().is_empty());
    assert_eq!(d.push(b"\x1b[201~",false).unwrap(),vec![ui::Key::Paste("g\ry\x03\n".into())]);
    let mut d=ui::Decoder::default();
    let mut big=b"\x1b[200~".to_vec();
    big.extend(vec![b'x';
    65537]);
    assert!(d.push(&big,false).is_err());
}
#[test]fn decoder_holds_split_utf8_and_rejects_invalid_bytes(){
    let mut d=ui::Decoder::default();
    assert!(d.push(&[0xe4,0xb8],false).unwrap().is_empty());
    assert_eq!(d.push(&[0xad],false).unwrap(),vec![ui::Key::Text("中".into())]);
    assert!(ui::Decoder::default().push(&[0xff],false).is_err());
    assert!(ui::Decoder::default().push(&[0xe4],true).is_err());
    assert_eq!(ui::Decoder::default().push(b"\x1b[A\x1b[6~\x1bO F",false).unwrap()[0],ui::Key::Up);
}
#[test]fn editor_history_undo_redo_and_input_budget_are_defensive(){
    let mut e=ui::Editor::default();
    e.apply(&ui::Key::Text("中ab".into())).unwrap();
    e.apply(&ui::Key::Left).unwrap();
    e.apply(&ui::Key::Backspace).unwrap();
    assert_eq!(e.text,"中b");
    e.apply(&ui::Key::Undo).unwrap();
    assert_eq!(e.text,"中ab");
    e.apply(&ui::Key::Redo).unwrap();
    assert_eq!(e.text,"中b");
    assert_eq!(e.take(),"中b");
    e.apply(&ui::Key::Up).unwrap();
    assert_eq!(e.text,"中b");
    e.apply(&ui::Key::Down).unwrap();
    assert_eq!(e.text,"");
    e.apply(&ui::Key::Text("a b".into())).unwrap();
    e.apply(&ui::Key::KillWord).unwrap();
    assert_eq!(e.text,"a ");
    e.apply(&ui::Key::Yank).unwrap();
    assert_eq!(e.text,"a b");
    e.at=1;
    assert!(e.apply(&ui::Key::Text("x".repeat(65536))).is_err());
    e.at=usize::MAX;
    assert!(e.apply(&ui::Key::Left).is_err());
}
#[test]fn approval_requires_same_second_choice_and_unarmed_enter_has_no_effect(){
    let mut g=ui::Gate{
        round:Some("r1".into()),digest:Some("pinned".into()),armed:None
    };
    assert_eq!(ui::press_gate(&mut g,&ui::Key::Enter),None);
    assert_eq!(ui::press_gate(&mut g,&ui::Key::Text("y".into())),None);
    assert_eq!(g.armed,Some(true));
    assert_eq!(ui::press_gate(&mut g,&ui::Key::Text("n".into())),None);
    assert_eq!(g.armed,Some(false));
    assert_eq!(ui::press_gate(&mut g,&ui::Key::Esc),None);
    assert_eq!(ui::press_gate(&mut g,&ui::Key::Enter),None);
    ui::press_gate(&mut g,&ui::Key::Text("y".into()));
    assert_eq!(ui::press_gate(&mut g,&ui::Key::Enter),Some(true));
    assert_eq!(g.armed,None);
}
#[test]fn command_tokens_do_not_expand_shell_syntax(){
    assert_eq!(ui::words("round plan 'a; $HOME && false'").unwrap(),vec!["round","plan","a; $HOME && false"]);
    assert_eq!(ui::words("say \"\"").unwrap(),vec!["say",""]);
    assert!(ui::words("!echo fail").is_err());
    assert!(ui::words("say 'unterminated").is_err());
    assert!(ui::words("say \0").is_err());
    assert!(ui::words(&"x ".repeat(257)).is_err());
}
#[test]fn follow_cursor_does_not_lose_late_writers_with_small_sequences(){
    let mut c=BTreeMap::new();
    assert_eq!(ui::read_new(&[row("a",10)],&mut c).unwrap().len(),1);
    assert_eq!(ui::read_new(&[row("b",1),row("a",10),row("a",11)],&mut c).unwrap().iter().map(|r|r.writer.as_str()).collect::<Vec<_>>(),vec!["b","a"]);
    assert!(ui::read_new(&[row("a",11),row("b",1)],&mut c).unwrap().is_empty());
    assert!(ui::read_new(&[row("../bad",1)],&mut c).is_err());
}
#[test]fn clipping_is_utf8_safe_and_unknown_terms_degrade(){
    assert_eq!(ui::width("中文"),4);
    assert_eq!(ui::clip("中文",3),"中…");
    assert_eq!(ui::clip("abc",0),"");
    assert!(!ui::ansi("dumb"));
    assert!(!ui::ansi("made-up"));
    assert!(ui::ansi("XTERM-256color"));
    assert!(ui::ansi("tmux-256color"));
}
struct Pty{
    child:Child,master:File,slave:File,original:libc::termios,bytes:Vec<u8>
}
impl Pty{
    fn start(root:&std::path::Path,extra:&[&str])->Self{
        Self::start_env(root,extra,&[])
    }
    fn start_env(root:&std::path::Path,extra:&[&str],env:&[(&str,&str)])->Self{
        let(mut m,mut s)=(-1,-1);
        let ws=libc::winsize{
            ws_row:24,ws_col:80,ws_xpixel:0,ws_ypixel:0
        };
        assert_eq!(unsafe{
            libc::openpty(&mut m,&mut s,std::ptr::null_mut(),std::ptr::null(),&ws)
        },0);
        let master=unsafe{
            File::from_raw_fd(m)
        };
        let slave=unsafe{
            File::from_raw_fd(s)
        };
        let mut original=unsafe{
            std::mem::zeroed()
        };
        assert_eq!(unsafe{
            libc::tcgetattr(s,&mut original)
        },0);
        let mut command=Command::new(env!("CARGO_BIN_EXE_fugue"));
        command.env("TERM","xterm-256color").env_remove("NO_COLOR");
        for (key,value) in env { command.env(key,value); }
        let child=command.arg("--root").arg(root).args(["tui","--full","--interval","10"]).args(extra).stdin(Stdio::from(slave.try_clone().unwrap())).stdout(Stdio::from(slave.try_clone().unwrap())).stderr(Stdio::from(slave.try_clone().unwrap())).spawn().unwrap();
        let flags=unsafe{
            libc::fcntl(m,libc::F_GETFL)
        };
        assert!(unsafe{
            libc::fcntl(m,libc::F_SETFL,flags|libc::O_NONBLOCK)
        }
        >=0);
        Self{
            child,master,slave,original,bytes:vec![]
        }
    }
    fn read(&mut self){
        let mut b=[0;
        8192];
        loop{
            match self.master.read(&mut b){
                Ok(0)=>break,Ok(n)=>self.bytes.extend_from_slice(&b[..n]),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>break,Err(e) if e.raw_os_error()==Some(libc::EIO)=>break,Err(e)=>panic!("PTY read: {e}")
            }
        }
    }
    fn until(&mut self,needle:&[u8]){
        let end=Instant::now()+Duration::from_secs(5);
        loop{
            self.read();
            if self.bytes.windows(needle.len()).any(|x|x==needle){
                return
            }
            assert!(Instant::now()<end,"PTY did not show {:?}: {}",needle,String::from_utf8_lossy(&self.bytes));
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn key(&mut self,b:&[u8]){
        assert!(b.len()<=131072,"PTY input batch exceeds the bounded test budget");
        let deadline=Instant::now()+Duration::from_secs(5);
        let mut written=0;
        while written<b.len(){
            assert!(Instant::now()<deadline,"PTY write timed out after {written}/{} bytes",b.len());
            match self.master.write(&b[written..]){
                Ok(0)=>panic!("PTY write made no progress after {written}/{} bytes",b.len()),
                Ok(n)=>written+=n,
                Err(e) if e.kind()==std::io::ErrorKind::Interrupted=>continue,
                Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{
                    // Drain the concurrently painted frame before waiting for
                    // space; otherwise a child blocked on output cannot read.
                    self.read();
                    let mut fd=libc::pollfd{fd:self.master.as_raw_fd(),events:libc::POLLOUT,revents:0};
                    let wait=deadline.saturating_duration_since(Instant::now()).as_millis().min(50) as i32;
                    let rc=unsafe{libc::poll(&mut fd,1,wait)};
                    if rc<0{
                        let error=std::io::Error::last_os_error();
                        assert_eq!(error.kind(),std::io::ErrorKind::Interrupted,"PTY write poll failed: {error}");
                    }else{
                        assert_eq!(fd.revents&(libc::POLLERR|libc::POLLHUP|libc::POLLNVAL),0,"PTY disconnected during write");
                    }
                },
                Err(e)=>panic!("PTY write failed after {written}/{} bytes: {e}",b.len()),
            }
        }
    }
    fn finish(&mut self)->i32{
        let end=Instant::now()+Duration::from_secs(5);
        loop{
            self.read();
            if let Some(s)=self.child.try_wait().unwrap(){
                self.read();
                let mut got=unsafe{
                    std::mem::zeroed()
                };
                assert_eq!(unsafe{
                    libc::tcgetattr(self.slave.as_raw_fd(),&mut got)
                },0);
                assert_eq!(got.c_lflag,self.original.c_lflag,"canonical/echo flags must restore");
                assert_eq!(got.c_iflag,self.original.c_iflag);
                assert_eq!(got.c_oflag,self.original.c_oflag);
                assert_eq!(got.c_cc,self.original.c_cc);
                assert!(self.bytes.windows(8).any(|x|x==b"\x1b[?2004l"),"paste mode restoration absent");
                assert!(self.bytes.windows(8).any(|x|x==b"\x1b[?1049l"),"alternate-screen restoration absent");
                return s.code().unwrap_or(128)
            }
            assert!(Instant::now()<end,"PTY process did not stop");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn real_pty_no_style_and_no_color_keep_raw_keyboard_navigation_and_fullscreen_controls() {
    let cases: &[(&[&str], &[(&str,&str)])] = &[
        (&["--no-style"], &[]),
        (&[], &[("NO_COLOR","1")]),
        (&["--no-style"], &[("NO_COLOR","1")]),
    ];
    for (args,env) in cases {
        let dir=tempfile::tempdir().unwrap();
        journal::append(dir.path(),"writer-a",json!({"t":"signal","agent":"writer-a"})).unwrap();
        journal::append(dir.path(),"writer-b",json!({"t":"signal","agent":"writer-b"})).unwrap();
        let before=journal::merged(dir.path()).unwrap();
        let mut p=Pty::start_env(dir.path(),args,env);
        p.until(b"\x1b[?1049h");
        p.until(b"\x1b[?2004h");
        let mut mode=unsafe{std::mem::zeroed()};
        assert_eq!(unsafe{libc::tcgetattr(p.slave.as_raw_fd(),&mut mode)},0);
        assert_eq!(mode.c_lflag&(libc::ICANON|libc::ECHO),0,"color preferences must not disable raw input");
        p.key(b"\t");
        p.until("Fugue · writer-a".as_bytes());
        p.key(b"?");
        p.until(b"Enter submits /command");
        p.key(b"\x1b");
        std::thread::sleep(Duration::from_millis(90));
        p.key(b"q");
        assert_eq!(p.finish(),0);
        assert!(p.bytes.windows(7).any(|bytes|bytes==b"\x1b[H\x1b[2J"));
        // The reset is restorative; no decorative SGR may be emitted in these modes.
        let text=String::from_utf8_lossy(&p.bytes);
        for capture in regex::Regex::new(r"\x1b\[([0-9;]*)m").unwrap().captures_iter(&text) {
            assert_eq!(&capture[1],"0","decorative attributes emitted with styling disabled");
        }
        assert_eq!(journal::merged(dir.path()).unwrap(),before);
    }
}
impl Drop for Pty{
    fn drop(&mut self){
        let _=self.child.kill();
        let _=self.child.wait();
    }
}
#[test]fn non_tty_snapshot_has_no_escape_and_is_read_only(){
    let d=tempfile::tempdir().unwrap();
    journal::append(d.path(),"a",json!({
        "t":"signal","agent":"a","id":"evil\u{1b}[2J"
    })).unwrap();
    let before=std::fs::read(d.path().join(".fugue/log/a.jsonl")).unwrap();
    let o=Command::new(env!("CARGO_BIN_EXE_fugue")).args(["--root"]).arg(d.path()).args(["tui","--once","--metrics","--report"]).output().unwrap();
    assert!(o.status.success(),"{}",String::from_utf8_lossy(&o.stderr));
    assert!(!o.stdout.contains(&27));
    assert!(String::from_utf8_lossy(&o.stdout).contains("八元指标"));
    assert_eq!(before,std::fs::read(d.path().join(".fugue/log/a.jsonl")).unwrap());
    assert!(!d.path().join(".fugue/log/round.jsonl").exists());
}
#[test]fn real_pty_restores_terminal_after_quit_ctrl_c_and_sigterm(){
    for key in [b"q".as_slice(),b"\x03".as_slice(),b"".as_slice()]{
        let d=tempfile::tempdir().unwrap();
        let mut p=Pty::start(d.path(),&[]);
        p.until(b"\x1b[?2004h");
        std::thread::sleep(Duration::from_millis(60));
        if key.is_empty(){
            assert_eq!(unsafe{
                libc::kill(p.child.id() as i32,libc::SIGTERM)
            },0)
        }
        else{
            p.key(key)
        }
        assert_eq!(p.finish(),0);
        assert!(!d.path().join(".fugue").exists());
    }
}
#[test]fn real_pty_restores_terminal_when_corrupt_log_causes_error(){
    let d=tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".fugue/log")).unwrap();
    std::fs::write(d.path().join(".fugue/log/a.jsonl"),b"{corrupt}\n").unwrap();
    let mut p=Pty::start(d.path(),&[]);
    assert_ne!(p.finish(),0);
    assert!(String::from_utf8_lossy(&p.bytes).contains("corrupt"));
}
#[test]
fn terminal_unwind_helper() {
    if std::env::var("FUGUE_UI_UNWIND_HELPER").as_deref() != Ok("1") {
        return;
    }
    let outcome = std::panic::catch_unwind(|| {
        let _: fugue::Result<()> = ui::terminal_scope(true, true, true, || {
            panic!("deliberate terminal unwind test");
        });
    });
    assert!(outcome.is_err());
}
#[test]
fn real_pty_restores_terminal_during_panic_unwind() {
    let (mut m, mut s) = (-1, -1);
    let size = libc::winsize {
        ws_row: 24, ws_col: 80, ws_xpixel: 0, ws_ypixel: 0
    };
    assert_eq!(unsafe {
        libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null(), &size)
    }, 0);
    let master = unsafe {
        File::from_raw_fd(m)
    };
    let slave = unsafe {
        File::from_raw_fd(s)
    };
    let mut original = unsafe {
        std::mem::zeroed()
    };
    assert_eq!(unsafe {
        libc::tcgetattr(s, &mut original)
    }, 0);
    let child = Command::new(std::env::current_exe().unwrap())         .args(["--exact", "terminal_unwind_helper", "--nocapture"])         .env("FUGUE_UI_UNWIND_HELPER", "1")         .stdin(Stdio::from(slave.try_clone().unwrap()))         .stdout(Stdio::from(slave.try_clone().unwrap()))         .stderr(Stdio::from(slave.try_clone().unwrap()))         .spawn().unwrap();
    let flags = unsafe {
        libc::fcntl(m, libc::F_GETFL)
    };
    assert!(unsafe {
        libc::fcntl(m, libc::F_SETFL, flags | libc::O_NONBLOCK)
    }
    >= 0);
    let mut p = Pty {
        child, master, slave, original, bytes: vec![]
    };
    assert_eq!(p.finish(), 0);
    assert!(String::from_utf8_lossy(&p.bytes).contains("deliberate terminal unwind test"));
}
fn approval_fixture(path: &std::path::Path, output: &str) {
    use fugue::{
        git::Git, util
    };
    assert!(Command::new("git").args(["init", "-q", "--initial-branch=main"]).arg(path).status().unwrap().success());
    let git = Git::open(path).unwrap();
    let tree = git.put_tree(&Default::default()).unwrap();
    let base = git.commit_tree(&tree, &[], "approval fixture base").unwrap();
    git.advance("refs/heads/main", &base, None).unwrap();
    approval_config(path, output);
    fugue::round::command(path, "plan", &["prepare output".into()], &json!({
    })).unwrap();
    assert!(!path.join(output).exists());
    assert!(!path.join(".git/index").exists());
    assert_eq!(util::read_limited(&path.join(".fugue/config"), util::MAX_BYTES).unwrap().first(), Some(&b'{'));
}
fn approval_config(path: &std::path::Path, output: &str) {
    let config = json!({
        "round": {
            "id": "r1", "split": [{
                "kind": "implement", "goal": "prepare output", "ownedPaths": [output],             "deliverables": [{
                    "path": output, "form": "file"
                }],             "assertions": [{
                    "name": "check", "action": "check", "expect": 0
                }]
            }]
        },         "actions": {
            "check": {
                "argv": ["/usr/bin/true"]
            }
        }
    });
    fugue::util::atomic_write(&path.join(".fugue/config"), &serde_json::to_vec(&config).unwrap()).unwrap();
}
#[test]
fn real_pty_approval_never_runs_before_a_second_explicit_choice() {
    let dir = tempfile::tempdir().unwrap();
    approval_fixture(dir.path(), "output");
    let mut p = Pty::start(dir.path(), &[]);
    p.until(b"g approval");
    p.key(b"g");
    p.until(b"y approve once");
    p.key(b"\r");
    std::thread::sleep(Duration::from_millis(50));
    assert!(!journal::read(dir.path(), "round").unwrap().iter().any(|r|r.event["t"]=="round/approve"));
    p.key(b"y");
    p.until(b"Press y again");
    assert!(!journal::read(dir.path(), "round").unwrap().iter().any(|r|r.event["t"]=="round/approve"));
    p.key(b"y");
    p.until(b"approved batch");
    p.key(b"q");
    assert_eq!(p.finish(), 0);
    let rows = journal::read(dir.path(), "round").unwrap();
    assert_eq!(rows.iter().filter(|r|r.event["t"]=="round/approve").count(),1);
    assert_eq!(rows.iter().filter(|r|r.event["t"]=="contract/issue").count(),1);
    assert!(!rows.iter().any(|r|r.event["t"]=="llm/call"));
    assert!(!dir.path().join("output").exists());
    assert!(!dir.path().join(".git/index").exists());
}
#[test]
fn real_pty_changed_batch_discards_armed_approval_instead_of_carrying_it_forward() {
    let dir = tempfile::tempdir().unwrap();
    approval_fixture(dir.path(), "old-output");
    let mut p = Pty::start(dir.path(), &[]);
    p.until(b"g approval");
    p.key(b"g");
    p.until(b"y approve once");
    p.key(b"y");
    p.until(b"Press y again");
    approval_config(dir.path(), "new-output");
    // Replan the changed draft under the same immutable round goal.
    fugue::round::command(dir.path(), "plan", &["prepare output".into()], &json!({
    })).unwrap();
    p.until(b"approval batch changed");
    p.key(b"y\r");
    std::thread::sleep(Duration::from_millis(100));
    assert!(!journal::read(dir.path(), "round").unwrap().iter().any(|r|r.event["t"]=="round/approve"));
    p.key(b"\x1b");
    std::thread::sleep(Duration::from_millis(80));
    p.key(b"q");
    assert_eq!(p.finish(), 0);
    assert!(!dir.path().join("new-output").exists());
}

#[test]
fn actual_wide_cluster_wrap_boundaries_position_caret_on_the_following_row() {
    for glyph in ["中","👨‍👩‍👧","🇨🇳","👍🏽","e\u{301}"] {
        let mut e=ui::Editor::default(); e.apply(&ui::Key::Text(format!("abc{glyph}z"))).unwrap(); e.at=3;
        let f=ui::input_frame(&e,"> ",6,3).unwrap();
        if glyph!="e\u{301}" {
            assert_eq!(f.rows,["> abc",&format!("  {glyph}z")]); assert_eq!(f.caret,ui::Caret{row:1,col:2});
            let scrolled=ui::input_frame(&e,"> ",6,1).unwrap(); assert_eq!(scrolled.caret,ui::Caret{row:0,col:2}); assert_eq!(scrolled.hidden,ui::Hidden{above:1,below:0});
            e.apply(&ui::Key::Left).unwrap(); assert_eq!(ui::input_frame(&e,"> ",6,3).unwrap().caret,ui::Caret{row:0,col:4});
            e.apply(&ui::Key::Right).unwrap(); e.apply(&ui::Key::Right).unwrap(); assert_eq!(e.at,3+glyph.len()); assert_eq!(ui::input_frame(&e,"> ",6,3).unwrap().caret,ui::Caret{row:1,col:4});
        } else { assert_eq!(f.caret,ui::Caret{row:0,col:5}); }
        assert_eq!(e.text,format!("abc{glyph}z"));
    }
    let mut e=ui::Editor::default(); e.apply(&ui::Key::Text("abc".into())).unwrap(); assert_eq!(ui::input_frame(&e,"> ",6,3).unwrap().caret,ui::Caret{row:0,col:5});
    e.apply(&ui::Key::Text("d".into())).unwrap(); let f=ui::input_frame(&e,"> ",6,3).unwrap(); assert_eq!(f.rows,["> abcd","  "]); assert_eq!(f.caret,ui::Caret{row:1,col:2});
}

#[test]
fn folded_paste_ranges_shift_delete_and_undo_without_changing_submitted_bytes() {
    let mut e=ui::Editor::default(); e.apply(&ui::Key::Text("before ".into())).unwrap(); let paste="a\nb\nc\nd\ne";
    e.apply(&ui::Key::Paste(paste.into())).unwrap(); e.apply(&ui::Key::Text(" after".into())).unwrap();
    let f=ui::input_frame(&e,"> ",80,3).unwrap(); assert!(f.rows[0].contains("before [粘贴 5 行 · 9 字] after"));
    let original=e.text.clone(); assert_eq!(original,format!("before {paste} after"));
    assert_eq!(ui::Decoder::default().push(b"\x0f",false).unwrap(),[ui::Key::ToggleFold]);
    e.apply(&ui::Key::ToggleFold).unwrap(); let f=ui::input_frame(&e,"> ",80,3).unwrap(); assert!(f.rows[0].contains("a↵b↵c↵d↵e")); assert_eq!(e.text,original);
    e.apply(&ui::Key::ToggleFold).unwrap(); e.apply(&ui::Key::Home).unwrap(); e.apply(&ui::Key::Text("prefix ".into())).unwrap();
    assert!(ui::input_frame(&e,"> ",80,3).unwrap().rows[0].contains("prefix before [粘贴 5 行 · 9 字] after"));
    e.at="prefix before ".len(); e.apply(&ui::Key::Right).unwrap(); assert_eq!(e.at,"prefix before ".len()+paste.len());
    e.apply(&ui::Key::Backspace).unwrap(); assert_eq!(e.text,"prefix before  after");
    e.apply(&ui::Key::Undo).unwrap(); assert!(ui::input_frame(&e,"> ",80,3).unwrap().rows[0].contains("[粘贴 5 行 · 9 字]"));
    e.apply(&ui::Key::Redo).unwrap(); assert_eq!(e.text,"prefix before  after");
    e.apply(&ui::Key::Undo).unwrap(); assert_eq!(e.take(),format!("prefix before {paste} after")); assert!(ui::input_frame(&e,"> ",80,3).unwrap().rows[0].starts_with("> "));
}

#[test]
fn expanded_long_input_preserves_all_spaces_clusters_and_safe_control_projections() {
    let source=" abc  中文 👨‍👩‍👧 e\u{301} 🇨🇳 👍🏽 \t\n\x1b\x03\x7f".repeat(300);
    let mut e=ui::Editor::default(); e.apply(&ui::Key::Paste(source.clone())).unwrap(); assert!(ui::input_frame(&e,"> ",80,3).unwrap().rows.iter().any(|r|r.contains("粘贴")));
    e.apply(&ui::Key::ToggleFold).unwrap();
    for w in [4,6,7,80,1000] { let f=ui::input_frame(&e,"> ",w,3).unwrap(); assert!(f.rows.len()<=3); assert!(f.caret.row<f.rows.len()); assert!(f.caret.col<w); for row in f.rows { assert!(ui::width(&row)<=w); assert!(!row.chars().any(char::is_control)); } }
    assert_eq!(e.text,source);
    e.apply(&ui::Key::Home).unwrap(); e.apply(&ui::Key::Text("edited ".into())).unwrap(); e.apply(&ui::Key::Undo).unwrap(); assert_eq!(e.text,source);
    let v=probe::readings_of(&[],&json!({})).unwrap(); let f=ui::frame(&v,&json!({"width":6,"height":8,"input":"abc中z"})).unwrap(); assert_eq!(f.len(),8); assert!(f[6].starts_with("> abc")); assert!(f[7].starts_with("  中z"));
    let mut unsafe_input=ui::Editor::default(); unsafe_input.apply(&ui::Key::Paste("\x1b]52;c;secret\x07\r\n\t\u{85}\u{202e}".into())).unwrap();
    for row in ui::input_frame(&unsafe_input,"> ",80,3).unwrap().rows { assert!(!row.contains('\x1b')); assert!(!row.contains('\u{85}')); assert!(!row.contains('\u{202e}')); assert!(!row.contains('\r')); assert!(!row.contains('\n')); }
    for (w,h) in [(0,3),(1001,3),(80,0),(80,1001)] { assert!(ui::input_frame(&e,"> ",w,h).is_err()); }
    assert!(ui::input_frame(&e,&"x".repeat(129),80,3).is_err());
}

impl Pty {
    fn until_after(&mut self,start:usize,needle:&[u8]) {
        let end=Instant::now()+Duration::from_secs(5);
        loop { self.read(); if self.bytes[start..].windows(needle.len()).any(|b|b==needle){return} assert!(Instant::now()<end,"PTY did not show new {:?}: {}",needle,String::from_utf8_lossy(&self.bytes[start..])); std::thread::sleep(Duration::from_millis(10)); }
    }
}
#[test]
fn real_pty_shows_and_moves_caret_across_a_wide_wrap_boundary() {
    let d=tempfile::tempdir().unwrap(); let mut p=Pty::start(d.path(),&[]); p.until(b"\x1b[?25h"); let ws=libc::winsize{ws_row:8,ws_col:6,ws_xpixel:0,ws_ypixel:0}; assert_eq!(unsafe{libc::ioctl(p.slave.as_raw_fd(),libc::TIOCSWINSZ,&ws)},0);
    p.key("abc中z".as_bytes()); p.until("  中z".as_bytes()); p.until(b"\x1b[8;6H\x1b[?25h");
    let start=p.bytes.len(); p.key(b"\x01\x1b[C\x1b[C\x1b[C"); p.until_after(start,b"\x1b[8;3H\x1b[?25h");
    let start=p.bytes.len(); p.key(b"\x1b[D"); p.until_after(start,b"\x1b[7;5H\x1b[?25h");
    let start=p.bytes.len(); p.key(b"\x1b[C\x1b[C"); p.until_after(start,b"\x1b[8;5H\x1b[?25h");
    p.key(b"\x01\x15q"); assert_eq!(p.finish(),0); assert!(!d.path().join(".fugue").exists());
}
#[test]
fn real_pty_long_paste_expands_edits_and_remains_unsubmitted() {
    let d=tempfile::tempdir().unwrap(); let mut p=Pty::start(d.path(),&[]); p.until(b"\x1b[?25h"); let ws=libc::winsize{ws_row:12,ws_col:40,ws_xpixel:0,ws_ypixel:0}; assert_eq!(unsafe{libc::ioctl(p.slave.as_raw_fd(),libc::TIOCSWINSZ,&ws)},0);
    let paste="payload-中-".repeat(1000); let mut keys=b"\x1b[200~".to_vec(); keys.extend_from_slice(paste.as_bytes()); keys.extend_from_slice(b"\x1b[201~"); p.key(&keys); p.until("[粘贴 1 行".as_bytes());
    let start=p.bytes.len(); p.key(b"\x0f"); p.until_after(start,"payload-中-".as_bytes());
    let start=p.bytes.len(); p.key(b"\x01EDIT-"); p.until_after(start,b"> EDIT-payload-");
    let start=p.bytes.len(); p.key(b"\x0f"); p.until_after(start,"[粘贴 1 行".as_bytes());
    p.key(b"\x01\x15q"); assert_eq!(p.finish(),0); assert!(!d.path().join(".fugue").exists());
}

#[test]
fn real_pty_idle_understanding_and_other_round_drafts_do_not_open_approval() {
    use sha2::{Sha256,Digest};
    for planning in [false,true] {
        let d=tempfile::tempdir().unwrap();
        if planning { journal::append(d.path(),"round",json!({"t":"round/state","round":"r1","from":"Idle","to":"Planning"})).unwrap(); }
        let body=if planning{"foreign round draft"}else{"discussion understanding"};
        let round=if planning{"other-round"}else{"r1"};
        let digest=format!("{:x}",Sha256::digest(body.as_bytes()))[..16].to_owned();
        journal::append(d.path(),"round",json!({"t":"holder/distill","round":round,"agent":"round","body":body,"digest":digest})).unwrap();
        let before=journal::merged(d.path()).unwrap(); let mut p=Pty::start(d.path(),&[]); p.until(b"g approval");
        let at=p.bytes.len(); p.key(b"g"); p.until_after(at,b"no pending approval batch");
        assert!(!String::from_utf8_lossy(&p.bytes[at..]).contains("Approval preview"));
        p.key(b"q"); assert_eq!(p.finish(),0); assert_eq!(journal::merged(d.path()).unwrap(),before);
    }
}

#[test]
fn real_pty_planning_does_not_reuse_prior_idle_understanding() {
    use sha2::{Sha256,Digest};
    let d=tempfile::tempdir().unwrap(); let body="understanding before planning";
    let digest=format!("{:x}",Sha256::digest(body.as_bytes()))[..16].to_owned();
    journal::append(d.path(),"round",json!({"t":"holder/distill","round":"r1","body":body,"digest":digest})).unwrap();
    journal::append(d.path(),"round",json!({"t":"round/state","round":"r1","from":"Idle","to":"Planning"})).unwrap();
    let before=journal::merged(d.path()).unwrap(); let mut p=Pty::start(d.path(),&[]); p.until(b"g approval");
    let start=p.bytes.len(); p.key(b"g"); p.until_after(start,b"no pending approval batch"); p.key(b"q"); assert_eq!(p.finish(),0);
    assert_eq!(journal::merged(d.path()).unwrap(),before);
}

#[test]
fn real_pty_foreign_writer_and_foreign_approval_cannot_replace_current_planning_preview() {
    let d=tempfile::tempdir().unwrap(); approval_fixture(d.path(),"current-output");
    journal::append(d.path(),"round",json!({"t":"round/approve","round":"other-round","fingerprint":"foreign"})).unwrap();
    journal::append(d.path(),"agent/other",json!({"t":"holder/distill","round":"r1","body":"untrusted foreign draft","digest":"invalid"})).unwrap();
    let before=journal::merged(d.path()).unwrap(); let mut p=Pty::start(d.path(),&[]); p.until(b"g approval"); p.key(b"g"); p.until(b"y approve once");
    assert!(!String::from_utf8_lossy(&p.bytes).contains("untrusted foreign draft"));
    p.key(b"\x1b"); std::thread::sleep(Duration::from_millis(80)); p.key(b"q"); assert_eq!(p.finish(),0);
    assert_eq!(journal::merged(d.path()).unwrap(),before); assert!(!d.path().join("current-output").exists());
}

#[test]
fn real_pty_round_change_invalidates_armed_gate_even_when_draft_bytes_are_identical() {
    use fugue::{config,util,round};
    let d=tempfile::tempdir().unwrap(); approval_fixture(d.path(),"same-output");
    let mut cfg=config::read(d.path()).unwrap(); cfg["round"]["id"]=json!("r2");
    util::atomic_write(&d.path().join(".fugue/config"),&serde_json::to_vec(&cfg).unwrap()).unwrap();
    round::command(d.path(),"plan",&["prepare output".into()],&json!({})).unwrap();
    let rows=journal::read(d.path(),"round").unwrap();
    let drafts=rows.iter().filter(|r|r.event["t"]=="holder/distill").collect::<Vec<_>>();
    assert_eq!(drafts.len(),2); assert_eq!(drafts[0].event["digest"],drafts[1].event["digest"],"this regression requires identical batches across distinct rounds");
    cfg["round"]["id"]=json!("r1"); util::atomic_write(&d.path().join(".fugue/config"),&serde_json::to_vec(&cfg).unwrap()).unwrap();
    let mut p=Pty::start(d.path(),&[]); p.until(b"g approval"); p.key(b"g"); p.until(b"y approve once"); p.key(b"y"); p.until(b"Press y again");
    cfg["round"]["id"]=json!("r2"); util::atomic_write(&d.path().join(".fugue/config"),&serde_json::to_vec(&cfg).unwrap()).unwrap();
    p.until(b"approval batch changed"); p.key(b"y\r"); std::thread::sleep(Duration::from_millis(80));
    assert!(!journal::read(d.path(),"round").unwrap().iter().any(|r|r.event["t"]=="round/approve"));
    p.key(b"\x1b"); std::thread::sleep(Duration::from_millis(80)); p.key(b"q"); assert_eq!(p.finish(),0);
    assert!(!d.path().join("same-output").exists()); assert!(!d.path().join(".git/index").exists());
}
