// Process & port inspection / termination.
//
// Backed by the OS command-line tools rather than a crate like `sysinfo`:
// we only need a listing plus a kill, and shelling out keeps the dependency
// tree (and the release binary) small. All parsing is defensive — these tools
// change their column layout between OS versions, so we never index blindly.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Hide the console window that would otherwise flash on every call in a
/// windowed (non-console) Tauri build. Equivalent to `CREATE_NO_WINDOW`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One listening/bound socket, joined with its owning process name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub protocol: String,
    pub local_addr: String,
    pub port: u16,
    /// Peer address for connected sockets, `"*:*"` for listeners. Included so
    /// the UI can distinguish the many `TIME_WAIT` rows that share a local
    /// port+PID and would otherwise collide as duplicate list keys.
    pub foreign_addr: String,
    pub state: String,
    pub pid: u32,
    pub process_name: String,
}

/// One running process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// Working-set size in kilobytes. `None` when the OS won't report it
    /// (access denied on system processes).
    pub memory_kb: Option<u64>,
}

/// Run a command and return stdout, hiding the console window on Windows.
///
/// Output is decoded lossily: `netstat`/`tasklist` emit text in the active
/// OEM code page (GBK on zh-CN), which is not valid UTF-8. Process names are
/// effectively ASCII, so replacing the odd invalid byte beats failing outright.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run {}: {}", program, e))?;
    if !out.status.success() {
        // Prefer stdout for "we could not find" messages that some tools
        // write there, but fall back to stderr when stdout is empty.
        let msg = String::from_utf8_lossy(if out.stdout.is_empty() {
            &out.stderr
        } else {
            &out.stdout
        });
        return Err(format!("{} failed: {}", program, msg.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Split a `host:port` suffix, tolerating IPv6 forms like `[::]:8080`.
///
/// Splits on the *last* colon because IPv6 addresses contain colons of their
/// own; a naive `split(':')` would return the wrong field for `[::1]:80`.
fn split_addr_port(addr: &str) -> Option<(String, u16)> {
    let idx = addr.rfind(':')?;
    let (host, port) = (&addr[..idx], &addr[idx + 1..]);
    // A wildcard port (`*`) is normal for some UDP rows — skip those.
    let port: u16 = port.parse().ok()?;
    Some((host.to_string(), port))
}

// ── Process listing ────────────────────────────────────────────

/// List running processes, newest listing each call (no caching — the caller
/// decides when to refresh).
#[tauri::command]
pub async fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    // Offloaded to a blocking thread: shelling out takes ~100ms and would
    // otherwise stall the async runtime that also serves the proxy.
    tokio::task::spawn_blocking(collect_processes)
        .await
        .map_err(|e| format!("Task join failed: {}", e))?
}

#[cfg(windows)]
fn collect_processes() -> Result<Vec<ProcessInfo>, String> {
    // `/fo csv /nh` gives a stable, quote-delimited layout — far safer to
    // parse than the default table, whose column widths shift with locale.
    let out = run("tasklist", &["/fo", "csv", "/nh"])?;
    let mut list = Vec::new();
    for line in out.lines() {
        let cols = parse_csv_row(line);
        // Layout: "name","pid","session","session#","mem usage"
        if cols.len() < 5 {
            continue;
        }
        let Ok(pid) = cols[1].trim().parse::<u32>() else {
            continue;
        };
        list.push(ProcessInfo {
            pid,
            name: cols[0].trim().to_string(),
            memory_kb: parse_mem_kb(&cols[4]),
        });
    }
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

#[cfg(not(windows))]
fn collect_processes() -> Result<Vec<ProcessInfo>, String> {
    // `comm=` prints the executable name without arguments; `rss` is in KB.
    let out = run("ps", &["-eo", "pid=,rss=,comm="])?;
    let mut list = Vec::new();
    for line in out.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(rss)) = (it.next(), it.next()) else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        let name = it.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        list.push(ProcessInfo {
            pid,
            name,
            memory_kb: rss.parse().ok(),
        });
    }
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

/// Parse a `tasklist /fo csv` row into unquoted fields.
///
/// Hand-rolled instead of pulling in a CSV crate: the format is fixed and the
/// only escape we have to honour is a doubled `""` inside a quoted field.
#[cfg(windows)]
fn parse_csv_row(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            // `""` inside a quoted field is a literal quote, not two state
            // flips — treating it as flips would desync every later column.
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                chars.next();
                cur.push('"');
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => fields.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    fields.push(cur);
    fields
}

/// Turn tasklist's `"12,345 K"` memory column into a number of kilobytes.
///
/// Returns None for `N/A`, which tasklist reports for processes it can't
/// query — surfacing that as `0` would wrongly look like real data.
#[cfg(windows)]
fn parse_mem_kb(raw: &str) -> Option<u64> {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

// ── Port listing ───────────────────────────────────────────────

/// List bound TCP/UDP sockets joined with the owning process name.
#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    tokio::task::spawn_blocking(collect_ports)
        .await
        .map_err(|e| format!("Task join failed: {}", e))?
}

fn collect_ports() -> Result<Vec<PortInfo>, String> {
    // Build the pid→name index once and reuse it for every socket row:
    // querying per row would be O(n) subprocess spawns (seconds, not ms).
    let names: std::collections::HashMap<u32, String> = collect_processes()
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.pid, p.name))
        .collect();
    let mut list = parse_netstat(&run_netstat()?);
    for p in &mut list {
        if let Some(n) = names.get(&p.pid) {
            p.process_name = n.clone();
        }
    }
    // Ascending port order is what you want when hunting "who owns 8080".
    list.sort_by_key(|p| (p.port, p.pid));
    Ok(list)
}

#[cfg(windows)]
fn run_netstat() -> Result<String, String> {
    // -a all sockets, -n numeric (skips slow reverse DNS), -o owning PID.
    run("netstat", &["-ano"])
}

#[cfg(not(windows))]
fn run_netstat() -> Result<String, String> {
    // -p needs root for *other* users' sockets but still lists our own.
    run("netstat", &["-anp"]).or_else(|_| run("ss", &["-anp"]))
}

/// Parse `netstat` rows into `PortInfo`.
///
/// Kept as a free function over `&str` so it can be unit-tested against
/// captured fixtures without spawning a real subprocess.
///
/// Column layout on Windows (`netstat -ano`), verified against a live zh-CN
/// Windows 10 (293 TCP rows / 38 UDP rows, no exceptions):
///   TCP: proto, local, foreign, state, pid   (5 fields)
///   UDP: proto, local, foreign, pid          (4 fields)
/// The PID is read from the last field and the state from the one before it
/// rather than by fixed index, so an extra token can't silently shift a
/// foreign address into the state column.
fn parse_netstat(raw: &str) -> Vec<PortInfo> {
    let mut list = Vec::new();
    for line in raw.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Shortest meaningful row is UDP: proto, local, foreign, pid.
        if cols.len() < 4 {
            continue;
        }
        let proto = cols[0].to_uppercase();
        // `ss` prints "tcp"/"udp" too, but also rows like "tcp6" — take those.
        if !proto.starts_with("TCP") && !proto.starts_with("UDP") {
            continue; // header / blank / "Active Connections" banner
        }
        let Some(pid) = cols.last().and_then(|s| parse_pid_field(s)) else {
            continue;
        };
        let Some((host, port)) = split_addr_port(cols[1]) else {
            continue;
        };
        // TCP carries a state column, UDP doesn't; index back from the PID.
        let state = if proto.starts_with("TCP") && cols.len() >= 5 {
            cols[cols.len() - 2].to_string()
        } else {
            "—".to_string()
        };
        list.push(PortInfo {
            protocol: proto,
            local_addr: host,
            port,
            foreign_addr: cols[2].to_string(),
            state,
            pid,
            process_name: String::new(),
        });
    }
    list
}

/// Read a PID out of a netstat/ss trailing field.
///
/// Windows prints a bare number. Linux `netstat -anp` / `ss -anp` print
/// `1234/nginx` (and `ss` wraps it as `users:(("nginx",pid=1234,fd=6))`), so a
/// plain `parse::<u32>()` would reject every Unix row and leave the list empty.
fn parse_pid_field(raw: &str) -> Option<u32> {
    if let Ok(pid) = raw.parse::<u32>() {
        return Some(pid);
    }
    // "1234/nginx" → 1234
    if let Some((head, _)) = raw.split_once('/') {
        if let Ok(pid) = head.parse::<u32>() {
            return Some(pid);
        }
    }
    // "users:((\"nginx\",pid=1234,fd=6))" → 1234
    let rest = raw.split("pid=").nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

// ── Termination ────────────────────────────────────────────────

/// PIDs that must never be killed: doing so bluescreens or hard-reboots the
/// machine. 0/4 are the Idle and System processes on Windows; 1 is init/systemd
/// on Unix.
#[cfg(windows)]
const PROTECTED_PIDS: &[u32] = &[0, 4];
#[cfg(not(windows))]
const PROTECTED_PIDS: &[u32] = &[0, 1];

/// Processes that trigger an immediate bugcheck or a forced reboot when killed.
///
/// A PID allow-list is not enough here: these all get *dynamic* PIDs at boot
/// (lsass.exe was 928 on the dev machine, not a fixed value), so the guard has
/// to match on the image name instead. Killing lsass.exe in particular starts
/// an unstoppable 60-second shutdown.
#[cfg(windows)]
const PROTECTED_NAMES: &[&str] = &[
    "system",
    "system idle process",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "memory compression",
];

#[cfg(not(windows))]
const PROTECTED_NAMES: &[&str] = &["init", "systemd", "kthreadd", "launchd", "kernel_task"];

/// True when `name` is a process we refuse to terminate.
///
/// Compared case-insensitively and with the `.exe` suffix optional, because
/// `tasklist` and the user-supplied value don't always agree on either.
fn is_protected_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    let stem = n.strip_suffix(".exe").unwrap_or(&n);
    PROTECTED_NAMES
        .iter()
        .any(|p| *p == n || p.strip_suffix(".exe").unwrap_or(p) == stem)
}

/// Kill a process by PID.
///
/// `force` maps to `taskkill /F` (SIGKILL); without it the process gets a
/// chance to shut down cleanly and can refuse. Killing our own process is
/// rejected — it would tear down the app mid-IPC and look like a crash.
///
/// The name guard resolves the PID through the live process list first, so a
/// critical process is refused even though its PID changes every boot.
#[tauri::command]
pub async fn kill_process(pid: u32, force: Option<bool>) -> Result<(), String> {
    if PROTECTED_PIDS.contains(&pid) {
        return Err(format!("PID {} is a protected system process", pid));
    }
    if pid == std::process::id() {
        return Err("Refusing to kill Easy-Copy itself".to_string());
    }
    let force = force.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        // Resolve the name *now* rather than trusting one passed from the UI:
        // the frontend list may be stale, and a PID can be recycled onto a
        // critical process between the refresh and the click.
        if let Some(name) = lookup_process_name(pid) {
            if is_protected_name(&name) {
                return Err(format!(
                    "Refusing to kill {} (PID {}): terminating it would crash or reboot Windows",
                    name, pid
                ));
            }
        }
        do_kill(pid, force)
    })
    .await
    .map_err(|e| format!("Task join failed: {}", e))?
}

/// Look up a single process name by PID, or `None` if it's gone or unreadable.
fn lookup_process_name(pid: u32) -> Option<String> {
    collect_processes()
        .ok()?
        .into_iter()
        .find(|p| p.pid == pid)
        .map(|p| p.name)
}

#[cfg(windows)]
fn do_kill(pid: u32, force: bool) -> Result<(), String> {
    let pid_s = pid.to_string();
    let mut args = vec!["/PID", pid_s.as_str()];
    if force {
        args.push("/F");
    }
    // taskkill reports "Access denied" / "not found" on stdout with a
    // non-zero status, which `run` surfaces verbatim to the UI.
    run("taskkill", &args).map(|_| ())
}

#[cfg(not(windows))]
fn do_kill(pid: u32, force: bool) -> Result<(), String> {
    let sig = if force { "-9" } else { "-15" };
    run("kill", &[sig, &pid.to_string()]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_parses_tcp_and_udp_rows() {
        // Captured from a real `netstat -ano` on Windows 10 (zh-CN).
        let raw = "\nActive Connections\n\n  Proto  Local Address    Foreign Address   State    PID\n  TCP    0.0.0.0:135      0.0.0.0:0         LISTENING   1044\n  TCP    [::]:445         [::]:0            LISTENING   4\n  UDP    0.0.0.0:5353     *:*                           2280\n";
        let list = parse_netstat(raw);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].port, 135);
        assert_eq!(list[0].pid, 1044);
        assert_eq!(list[0].state, "LISTENING");
        // IPv6 host must survive the last-colon split intact.
        assert_eq!(list[1].local_addr, "[::]");
        assert_eq!(list[1].port, 445);
        // UDP has no state column; PID is still the final field.
        assert_eq!(list[2].protocol, "UDP");
        assert_eq!(list[2].pid, 2280);
        assert_eq!(list[2].state, "—");
    }

    #[test]
    fn netstat_skips_headers_and_wildcard_ports() {
        let raw = "  Proto Local Address\n  TCP    *:*    *:*    LISTENING   9\n";
        assert!(parse_netstat(raw).is_empty());
    }

    #[test]
    fn split_addr_port_handles_ipv6() {
        assert_eq!(
            split_addr_port("[::1]:8080"),
            Some(("[::1]".to_string(), 8080))
        );
        assert_eq!(
            split_addr_port("127.0.0.1:80"),
            Some(("127.0.0.1".to_string(), 80))
        );
        assert_eq!(split_addr_port("0.0.0.0:*"), None);
    }

    #[cfg(windows)]
    #[test]
    fn csv_row_keeps_commas_inside_quotes() {
        let cols = parse_csv_row("\"chrome.exe\",\"1234\",\"Console\",\"1\",\"123,456 K\"");
        assert_eq!(cols.len(), 5);
        assert_eq!(cols[0], "chrome.exe");
        assert_eq!(parse_mem_kb(&cols[4]), Some(123_456));
    }

    #[cfg(windows)]
    #[test]
    fn mem_na_is_none_not_zero() {
        assert_eq!(parse_mem_kb("N/A"), None);
    }

    #[tokio::test]
    async fn protected_pids_are_rejected() {
        assert!(kill_process(0, Some(true)).await.is_err());
        assert!(kill_process(std::process::id(), Some(true)).await.is_err());
    }

    #[test]
    fn protected_names_match_regardless_of_case_and_suffix() {
        // These get dynamic PIDs at boot, so the name guard is the only
        // thing standing between a mis-click and a forced reboot.
        assert!(is_protected_name("lsass.exe"));
        assert!(is_protected_name("LSASS.EXE"));
        assert!(is_protected_name("  Csrss.exe  "));
        assert!(is_protected_name("wininit"));
        assert!(!is_protected_name("notepad.exe"));
        // Substring collisions must not be treated as protected.
        assert!(!is_protected_name("lsass_helper.exe"));
        assert!(!is_protected_name("mylsass.exe"));
    }

    #[test]
    fn time_wait_rows_are_distinguishable_by_foreign_addr() {
        // Real capture: same local port, same PID, different peers. Without
        // foreign_addr these collapse into one duplicate React key.
        let raw = "  TCP    127.0.0.1:55296   127.0.0.1:51524   TIME_WAIT   0\n  TCP    127.0.0.1:55296   127.0.0.1:51530   TIME_WAIT   0\n";
        let list = parse_netstat(raw);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].state, "TIME_WAIT");
        assert_ne!(list[0].foreign_addr, list[1].foreign_addr);
    }

    #[test]
    fn unix_pid_field_formats_are_parsed() {
        // Bare (Windows), netstat -anp, and ss -anp respectively.
        assert_eq!(parse_pid_field("1044"), Some(1044));
        assert_eq!(parse_pid_field("1234/nginx"), Some(1234));
        assert_eq!(
            parse_pid_field("users:((\"nginx\",pid=1234,fd=6))"),
            Some(1234)
        );
        assert_eq!(parse_pid_field("-"), None);
    }

    #[cfg(windows)]
    #[test]
    fn csv_row_unescapes_doubled_quotes() {
        let cols = parse_csv_row("\"a\"\"b.exe\",\"7\",\"Console\",\"1\",\"8 K\"");
        assert_eq!(cols.len(), 5);
        assert_eq!(cols[0], "a\"b.exe");
        assert_eq!(cols[1], "7");
    }
}
