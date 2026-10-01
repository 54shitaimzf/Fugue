#![forbid(unsafe_op_in_unsafe_fn)]
pub mod util;
pub mod config;
pub mod git;
pub mod journal;
pub mod view;
pub mod sandbox;
pub mod tools;
pub mod model;
pub mod assemble;
pub mod round;
pub mod merge;
pub mod probe;
pub mod contracts;
pub mod ui;
pub mod session;
#[derive(Debug)]
pub struct Error { pub code:i32,pub message:String }
impl Error { pub fn new(x:impl Into<String>)->Self{Self{code:1,message:x.into()}} pub fn usage(x:impl Into<String>)->Self{Self{code:2,message:x.into()}} pub fn unsupported(x:impl Into<String>)->Self{Self::new(format!("unsupported: {}",x.into()))} }
impl std::fmt::Display for Error{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str(&self.message)}}
impl std::error::Error for Error{}
impl From<std::io::Error> for Error{fn from(x:std::io::Error)->Self{Self::new(format!("I/O failure: {x}"))}}
impl From<serde_json::Error> for Error{fn from(x:serde_json::Error)->Self{Self::new(format!("invalid JSON at {}:{}",x.line(),x.column()))}}
pub type Result<T> = std::result::Result<T,Error>;
