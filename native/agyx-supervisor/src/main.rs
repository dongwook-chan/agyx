use chrono::{Duration, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use signal_hook::consts::signal::{SIGINT, SIGTERM};
use signal_hook::iterator::Signals;
use std::collections::HashSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize)]
struct SessionRecord {
    id: String,
    pid: u32,
    #[serde(rename = "childPid", skip_serializing_if = "Option::is_none")]
    child_pid: Option<u32>,
    cwd: String,
    args: Vec<String>,
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(rename = "socketPath")]
    socket_path: String,
    #[serde(rename = "logPath")]
    log_path: String,
    paused: bool,
    restartable: bool,
    #[serde(rename = "startedAt")]
    started_at: String,
    #[serde(rename = "currentModelLabel", skip_serializing_if = "Option::is_none")]
    current_model_label: Option<String>,
    #[serde(rename = "currentQuotaScope", skip_serializing_if = "Option::is_none")]
    current_quota_scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionCommand {
    command: String,
}

struct Supervisor {
    id: String,
    args: Vec<String>,
    cwd: String,
    real_agy: String,
    socket_path: PathBuf,
    record_path: PathBuf,
    log_path: PathBuf,
    started_at: String,
    child: Option<Child>,
    paused: bool,
    intentional_stop: bool,
    conversation_id: Option<String>,
    log_offset: usize,
    profile_at_start: Option<String>,
    quota_marked_scopes: HashSet<String>,
    current_model_label: Option<String>,
    current_quota_scope: Option<String>,
    persist_count: usize,
}

impl Supervisor {
    fn record(&self) -> SessionRecord {
        SessionRecord {
            id: self.id.clone(),
            pid: std::process::id(),
            child_pid: self.child.as_ref().map(|child| child.id()),
            cwd: self.cwd.clone(),
            args: self.args.clone(),
            conversation_id: self.conversation_id.clone(),
            socket_path: self.socket_path.to_string_lossy().to_string(),
            log_path: self.log_path.to_string_lossy().to_string(),
            paused: self.paused,
            restartable: true,
            started_at: self.started_at.clone(),
            current_model_label: self.current_model_label.clone(),
            current_quota_scope: self.current_quota_scope.clone(),
        }
    }

    fn persist(&mut self) -> Result<SessionRecord, String> {
        let record = self.record();
        let temporary = self.record_path.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            self.persist_count,
        ));
        self.persist_count += 1;
        write_json_file(&temporary, &serde_json::to_value(&record).map_err(to_string)?)?;
        fs::rename(&temporary, &self.record_path).map_err(to_string)?;
        Ok(record)
    }

    fn start_child(&mut self) -> Result<(), String> {
        self.intentional_stop = false;
        self.paused = false;
        self.profile_at_start = active_profile()?;
        self.quota_marked_scopes.clear();
        self.current_model_label = None;
        self.current_quota_scope = None;

        let mut launch_args = with_conversation(&self.args, self.conversation_id.as_deref());
        if !launch_args.iter().any(|arg| arg == "--log-file" || arg.starts_with("--log-file=")) {
            launch_args.push("--log-file".to_string());
            launch_args.push(self.log_path.to_string_lossy().to_string());
        }

        let child = Command::new(&self.real_agy)
            .args(&launch_args)
            .current_dir(&self.cwd)
            .env("AGYX_MANAGED", "1")
            .env("AGYX_SESSION_ID", &self.id)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(to_string)?;
        self.child = Some(child);
        self.persist()?;
        Ok(())
    }

    fn stop_child(&mut self) -> Result<(), String> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        self.intentional_stop = true;
        let _ = Command::new("/bin/kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
        for _ in 0..50 {
            if child.try_wait().map_err(to_string)?.is_some() {
                self.refresh_conversation();
                return Ok(());
            }
            thread::sleep(StdDuration::from_millis(100));
        }
        let _ = Command::new("/bin/kill")
            .arg("-KILL")
            .arg(child.id().to_string())
            .status();
        let _ = child.wait();
        self.refresh_conversation();
        Ok(())
    }

    fn refresh_conversation(&mut self) {
        if let Ok(content) = fs::read_to_string(&self.log_path) {
            if let Some(conversation) = detect_conversation(&content) {
                self.conversation_id = Some(conversation);
            }
        }
    }

    fn scan_log_events(&mut self) {
        let Some(profile_name) = self.profile_at_start.clone() else {
            return;
        };
        let Ok(content) = fs::read_to_string(&self.log_path) else {
            return;
        };
        if content.len() < self.log_offset {
            self.log_offset = 0;
        }
        let appended = &content[self.log_offset..];
        self.log_offset = content.len();
        let mut model_changed = false;

        if let Some(conversation) = detect_conversation(appended) {
            self.conversation_id = Some(conversation);
        }

        for line in appended.lines() {
            if let Some((label, scope)) = parse_model_event_line(line) {
                self.current_model_label = Some(label);
                self.current_quota_scope = Some(scope);
                model_changed = true;
            }
            if is_request_event_line(line) {
                let _ = record_profile_request(&profile_name);
            }
            if let Some(reason) = parse_eligibility_event_line(line) {
                let _ = record_profile_ineligible(&profile_name, &reason);
            }
            if let Some((reason, reset_at)) = parse_quota_event_line(line) {
                let scope = self
                    .current_quota_scope
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                if self.quota_marked_scopes.contains(&scope) {
                    continue;
                }
                self.quota_marked_scopes.insert(scope.clone());
                let _ = record_profile_quota_exhausted(
                    &profile_name,
                    &reason,
                    reset_at.as_deref(),
                    &scope,
                    self.current_model_label.as_deref(),
                );
                trigger_auto_switch(&scope);
            }
        }

        if model_changed {
            let _ = self.persist();
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(args) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("agyx: {error}");
            std::process::exit(1);
        }
    }
}

fn run(args: Vec<String>) -> Result<i32, String> {
    if !is_restartable(&args) {
        let real_agy = find_real_agy()?;
        let status = Command::new(real_agy)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(to_string)?;
        return Ok(status.code().unwrap_or(1));
    }

    ensure_directories()?;
    let id = format!("{}-{:x}", std::process::id(), now_nanos());
    let runtime = runtime_dir();
    let logs = log_dir();
    let socket_path = runtime.join(format!("{}.sock", std::process::id()));
    let record_path = runtime.join(format!("{id}.json"));
    let log_path = logs.join(format!("session-{id}.log"));
    let _ = fs::remove_file(&socket_path);
    let real_agy = find_real_agy()?;
    let cwd = env::current_dir().map_err(to_string)?.to_string_lossy().to_string();

    let supervisor = Arc::new(Mutex::new(Supervisor {
        id,
        args,
        cwd,
        real_agy,
        socket_path: socket_path.clone(),
        record_path: record_path.clone(),
        log_path,
        started_at: now_iso(),
        child: None,
        paused: false,
        intentional_stop: false,
        conversation_id: None,
        log_offset: 0,
        profile_at_start: None,
        quota_marked_scopes: HashSet::new(),
        current_model_label: None,
        current_quota_scope: None,
        persist_count: 0,
    }));

    supervisor.lock().map_err(to_string)?.start_child()?;
    start_socket_server(supervisor.clone(), socket_path.clone())?;
    start_signal_handler(supervisor.clone(), socket_path.clone(), record_path.clone())?;

    loop {
        thread::sleep(StdDuration::from_millis(500));
        let mut guard = supervisor.lock().map_err(to_string)?;
        guard.scan_log_events();
        let exited = match guard.child.as_mut() {
            Some(child) => child.try_wait().map_err(to_string)?.map(|status| status.code().unwrap_or(1)),
            None => None,
        };
        if let Some(code) = exited {
            guard.refresh_conversation();
            guard.child = None;
            let _ = guard.persist();
            if guard.intentional_stop || guard.paused {
                cleanup_paths(&socket_path, &record_path);
                return Ok(code);
            }
            let is_abnormal = code != 0 || is_abnormal_exit_log(&guard.log_path);
            if !is_abnormal {
                cleanup_paths(&socket_path, &record_path);
                return Ok(0);
            } else {
                eprintln!("\n[agyx] Session ended unexpectedly (exit code {}). Restarting...", code);
                thread::sleep(StdDuration::from_secs(1));
                guard.start_child()?;
            }
        }
    }
}

fn start_socket_server(supervisor: Arc<Mutex<Supervisor>>, socket_path: PathBuf) -> Result<(), String> {
    let listener = UnixListener::bind(socket_path).map_err(to_string)?;
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let supervisor = supervisor.clone();
            thread::spawn(move || {
                let _ = handle_socket(supervisor, stream);
            });
        }
    });
    Ok(())
}

fn handle_socket(supervisor: Arc<Mutex<Supervisor>>, mut stream: UnixStream) -> Result<(), String> {
    let mut input = String::new();
    stream.read_to_string(&mut input).map_err(to_string)?;
    let request: SessionCommand = serde_json::from_str(&input).map_err(to_string)?;
    let mut guard = supervisor.lock().map_err(to_string)?;
    let reply = match request.command.as_str() {
        "pause" => {
            guard.paused = true;
            guard.stop_child()?;
            let record = guard.persist()?;
            json!({ "ok": true, "record": record })
        }
        "resume" => {
            if guard.child.is_none() {
                guard.start_child()?;
            }
            json!({ "ok": true })
        }
        "shutdown" => {
            guard.stop_child()?;
            let socket_path = guard.socket_path.clone();
            let record_path = guard.record_path.clone();
            let reply = json!({ "ok": true });
            let _ = stream.write_all(format!("{}\n", serde_json::to_string(&reply).map_err(to_string)?).as_bytes());
            cleanup_paths(&socket_path, &record_path);
            std::process::exit(0);
        }
        _ => {
            guard.refresh_conversation();
            let record = guard.persist()?;
            json!({ "ok": true, "record": record })
        }
    };
    stream
        .write_all(format!("{}\n", serde_json::to_string(&reply).map_err(to_string)?).as_bytes())
        .map_err(to_string)?;
    Ok(())
}

fn start_signal_handler(
    supervisor: Arc<Mutex<Supervisor>>,
    socket_path: PathBuf,
    record_path: PathBuf,
) -> Result<(), String> {
    let mut signals = Signals::new([SIGINT, SIGTERM]).map_err(to_string)?;
    thread::spawn(move || {
        if let Some(signal) = signals.forever().next() {
            if let Ok(mut guard) = supervisor.lock() {
                let _ = guard.stop_child();
            }
            cleanup_paths(&socket_path, &record_path);
            std::process::exit(if signal == SIGINT { 130 } else { 143 });
        }
    });
    Ok(())
}

fn cleanup_paths(socket_path: &Path, record_path: &Path) {
    let _ = fs::remove_file(socket_path);
    let _ = fs::remove_file(record_path);
}

fn config_dir() -> PathBuf {
    if let Ok(value) = env::var("AGYX_CONFIG_DIR") {
        return PathBuf::from(value);
    }
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".to_string()))
        .join(".config")
        .join("agyx")
}

fn runtime_dir() -> PathBuf {
    config_dir().join("run")
}

fn log_dir() -> PathBuf {
    config_dir().join("logs")
}

fn state_path() -> PathBuf {
    config_dir().join("state.json")
}

fn ensure_directories() -> Result<(), String> {
    for directory in [config_dir(), runtime_dir(), log_dir()] {
        fs::create_dir_all(&directory).map_err(to_string)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(to_string)?;
    }
    Ok(())
}

fn load_state() -> Result<Value, String> {
    match fs::read_to_string(state_path()) {
        Ok(content) => serde_json::from_str(&content).map_err(to_string),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "version": 1, "profiles": [] }))
        }
        Err(error) => Err(to_string(error)),
    }
}

fn save_state(state: &Value) -> Result<(), String> {
    ensure_directories()?;
    write_json_file(&state_path(), state)
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension().and_then(|extension| extension.to_str()).unwrap_or("json"),
        std::process::id(),
    ));
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(to_string)?;
    file.write_all(serde_json::to_string_pretty(value).map_err(to_string)?.as_bytes())
        .map_err(to_string)?;
    file.write_all(b"\n").map_err(to_string)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).map_err(to_string)?;
    fs::rename(&temporary, path).map_err(to_string)?;
    Ok(())
}

fn active_profile() -> Result<Option<String>, String> {
    Ok(load_state()?
        .get("activeProfile")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn find_real_agy() -> Result<String, String> {
    if let Ok(path) = env::var("AGYX_REAL_AGY") {
        if is_executable(Path::new(&path)) {
            return Ok(path);
        }
    }

    let mut state = load_state()?;
    if let Some(path) = state.get("realAgyPath").and_then(Value::as_str) {
        if is_executable(Path::new(path)) {
            return Ok(path.to_string());
        }
    }

    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/agy"),
        PathBuf::from("/usr/local/bin/agy"),
    ];
    if let Ok(path) = env::var("PATH") {
        for directory in path.split(':') {
            candidates.push(PathBuf::from(directory).join("agy"));
        }
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_string();
        if !seen.insert(key.clone()) || !is_executable(&candidate) {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&candidate) {
            if content.contains("agyx session") || content.contains("agyx-agy") {
                continue;
            }
        }
        state["realAgyPath"] = Value::String(key.clone());
        let _ = save_state(&state);
        return Ok(key);
    }
    Err("The real agy executable was not found. Set AGYX_REAL_AGY.".to_string())
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn is_restartable(args: &[String]) -> bool {
    !args.iter().any(|arg| arg == "-p" || arg == "--print" || arg == "--prompt")
}

fn is_abnormal_exit_log(log_path: &Path) -> bool {
    if let Ok(content) = fs::read_to_string(log_path) {
        let keywords = [
            "signal terminated",
            "Got signal",
            "model unreachable",
            "context canceled",
            "quota reached",
            "quota exceeded",
            "RESOURCE_EXHAUSTED",
            "connection lost",
            "connection closed",
            "stream error",
        ];
        keywords.iter().any(|kw| content.contains(kw))
    } else {
        false
    }
}

fn with_conversation(args: &[String], conversation_id: Option<&str>) -> Vec<String> {
    let Some(conversation_id) = conversation_id else {
        return args.to_vec();
    };
    let mut result = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if argument == "-c" || argument == "--continue" {
            index += 1;
            continue;
        }
        if argument == "--conversation" {
            index += 2;
            continue;
        }
        if argument.starts_with("--conversation=") {
            index += 1;
            continue;
        }
        result.push(argument.clone());
        index += 1;
    }
    result.push("--conversation".to_string());
    result.push(conversation_id.to_string());
    result
}

fn detect_conversation(content: &str) -> Option<String> {
    let pattern = Regex::new(
        r"(?i)(?:Created conversation|GetConversationDetail: found conversation|Conversation using ID:) ([0-9a-f-]{36})",
    )
    .ok()?;
    pattern
        .captures_iter(content)
        .filter_map(|capture| capture.get(1).map(|m| m.as_str().to_string()))
        .last()
}

fn is_request_event_line(line: &str) -> bool {
    Regex::new(r"(?i)Sending user message to conversation [0-9a-f-]{36}")
        .map(|pattern| pattern.is_match(line))
        .unwrap_or(false)
}

fn classify_model_scope(label: &str) -> String {
    let lower = label.to_lowercase();
    if lower.contains("claude") {
        "claude".to_string()
    } else if lower.contains("gemini") {
        "gemini".to_string()
    } else if lower.contains("gpt-oss") || lower.contains("gpt oss") {
        "gpt-oss".to_string()
    } else {
        "unknown".to_string()
    }
}

fn parse_model_event_line(line: &str) -> Option<(String, String)> {
    if let Ok(pattern) = Regex::new(r#"(?i)Propagating selected model override to backend:\s+label="([^"]+)""#) {
        if let Some(label) = pattern.captures(line).and_then(|capture| capture.get(1)) {
            let label = label.as_str().to_string();
            return Some((label.clone(), classify_model_scope(&label)));
        }
    }
    if let Ok(pattern) = Regex::new(r"(?i)Resolving model\s+(.+)$") {
        if let Some(label) = pattern.captures(line).and_then(|capture| capture.get(1)) {
            let label = label.as_str().trim().to_string();
            return Some((label.clone(), classify_model_scope(&label)));
        }
    }
    None
}

fn parse_eligibility_event_line(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    if !(lower.contains("account ineligible")
        || lower.contains("not eligible for antigravity")
        || lower.contains("eligibility check failed"))
    {
        return None;
    }
    if let Ok(pattern) = Regex::new(r"(?i)Account ineligible:\s*(.+)$") {
        if let Some(reason) = pattern.captures(line).and_then(|capture| capture.get(1)) {
            return Some(reason.as_str().to_string());
        }
    }
    if let Ok(pattern) = Regex::new(r"(?i)Eligibility check failed:\s*(.+)$") {
        if let Some(reason) = pattern.captures(line).and_then(|capture| capture.get(1)) {
            return Some(reason.as_str().to_string());
        }
    }
    Some("account is not eligible for Antigravity; verify it in the browser or login another account".to_string())
}

fn parse_quota_event_line(line: &str) -> Option<(String, Option<String>)> {
    let lower = line.to_lowercase();
    let has_429 = regex_match(r"\b429\b", line);
    let code_429 = regex_match(r"(?i)\bcode\s*[:=]?\s*429\b", line);
    let quota_limit = regex_match(r"(?i)(quota|rate limit).*(exceeded|exhausted|reached)", line);
    let looks_like_quota = lower.contains("resource_exhausted")
        || lower.contains("individual quota reached")
        || code_429
        || (has_429 && regex_match(r"(?i)(quota|rate|limit|exhausted)", line))
        || quota_limit;
    if !looks_like_quota {
        return None;
    }

    let reason = if lower.contains("individual quota reached") {
        "individual quota reached"
    } else if lower.contains("resource_exhausted") {
        "RESOURCE_EXHAUSTED"
    } else if has_429 {
        "HTTP 429"
    } else {
        "quota exhausted"
    };
    Some((reason.to_string(), parse_reset_at(line)))
}

fn parse_reset_at(line: &str) -> Option<String> {
    if let Ok(pattern) = Regex::new(r"(?i)resets?\s+in\s+([0-9a-zA-Z.\s]+)") {
        if let Some(value) = pattern.captures(line).and_then(|capture| capture.get(1)) {
            if let Some(duration) = parse_duration(value.as_str()) {
                return Some((Utc::now() + duration).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
    }
    if let Ok(pattern) = Regex::new(r#"(?i)retry-after["'\s:=]+(\d+)"#) {
        if let Some(seconds) = pattern.captures(line).and_then(|capture| capture.get(1)) {
            if let Ok(seconds) = seconds.as_str().parse::<i64>() {
                return Some((Utc::now() + Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
    }
    None
}

fn parse_duration(value: &str) -> Option<Duration> {
    let pattern = Regex::new(
        r"(?i)(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)",
    )
    .ok()?;
    let mut total_ms = 0.0;
    let mut matched = false;
    for capture in pattern.captures_iter(value) {
        matched = true;
        let amount = capture.get(1)?.as_str().parse::<f64>().ok()?;
        let unit = capture.get(2)?.as_str().to_lowercase();
        if unit.starts_with('d') {
            total_ms += amount * 24.0 * 60.0 * 60.0 * 1000.0;
        } else if unit.starts_with('h') {
            total_ms += amount * 60.0 * 60.0 * 1000.0;
        } else if unit.starts_with('m') {
            total_ms += amount * 60.0 * 1000.0;
        } else {
            total_ms += amount * 1000.0;
        }
    }
    if matched {
        Some(Duration::milliseconds(total_ms.round() as i64))
    } else {
        None
    }
}

fn record_profile_request(name: &str) -> Result<(), String> {
    let mut state = load_state()?;
    let now = now_iso();
    if let Some(profile) = find_profile_mut(&mut state, name) {
        profile["lastRequestAt"] = Value::String(now.clone());
        profile["lastSuccessfulRequestAt"] = Value::String(now.clone());
        profile["updatedAt"] = Value::String(now);
        if profile.get("quotaStatus").and_then(Value::as_str) != Some("exhausted") {
            profile["quotaStatus"] = Value::String("available".to_string());
        }
        profile["eligibilityStatus"] = Value::String("eligible".to_string());
        remove_key(profile, "eligibilityReason");
        remove_key(profile, "lastEligibilityErrorAt");
    }
    save_state(&state)
}

fn record_profile_ineligible(name: &str, reason: &str) -> Result<(), String> {
    let mut state = load_state()?;
    let now = now_iso();
    if let Some(profile) = find_profile_mut(&mut state, name) {
        profile["eligibilityStatus"] = Value::String("ineligible".to_string());
        profile["lastEligibilityErrorAt"] = Value::String(now.clone());
        profile["eligibilityReason"] = Value::String(reason.to_string());
        profile["updatedAt"] = Value::String(now);
    }
    save_state(&state)
}

fn record_profile_quota_exhausted(
    name: &str,
    reason: &str,
    reset_at: Option<&str>,
    scope: &str,
    model_label: Option<&str>,
) -> Result<(), String> {
    let mut state = load_state()?;
    let now = now_iso();
    if let Some(profile) = find_profile_mut(&mut state, name) {
        profile["lastQuotaErrorAt"] = Value::String(now.clone());
        profile["lastQuotaReason"] = Value::String(reason.to_string());
        if !profile.get("quotaScopes").map(Value::is_object).unwrap_or(false) {
            profile["quotaScopes"] = json!({});
        }
        let mut record = json!({
            "status": "exhausted",
            "reason": reason,
            "errorAt": now,
        });
        if let Some(reset_at) = reset_at {
            record["resetAt"] = Value::String(reset_at.to_string());
        }
        if let Some(model_label) = model_label {
            record["modelLabel"] = Value::String(model_label.to_string());
        }
        profile["quotaScopes"][scope] = record;
        if scope == "unknown" {
            profile["quotaStatus"] = Value::String("exhausted".to_string());
            if let Some(reset_at) = reset_at {
                profile["quotaResetAt"] = Value::String(reset_at.to_string());
            }
        }
        profile["updatedAt"] = Value::String(now_iso());
    }
    save_state(&state)
}

fn find_profile_mut<'a>(state: &'a mut Value, name: &str) -> Option<&'a mut Value> {
    let profiles = state.get_mut("profiles")?.as_array_mut()?;
    profiles.iter_mut().find(|profile| {
        profile.get("name").and_then(Value::as_str) == Some(name)
            || profile
                .get("previousNames")
                .and_then(Value::as_array)
                .map(|names| names.iter().any(|entry| entry.as_str() == Some(name)))
                .unwrap_or(false)
    })
}

fn remove_key(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        object.remove(key);
    }
}

fn trigger_auto_switch(scope: &str) {
    let mut command = if let Ok(cli_path) = env::var("AGYX_CLI_PATH") {
        let node_path = env::var("AGYX_NODE_PATH").unwrap_or_else(|_| "node".to_string());
        let mut command = Command::new(node_path);
        command.arg(cli_path);
        command
    } else {
        Command::new("agyx")
    };
    let _ = command
        .arg("_auto-next")
        .arg(scope)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("AGYX_AUTO_SWITCH_TRIGGER", "1")
        .spawn();
}

fn regex_match(pattern: &str, input: &str) -> bool {
    Regex::new(pattern)
        .map(|regex| regex.is_match(input))
        .unwrap_or(false)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
