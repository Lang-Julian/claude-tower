// Bring an iTerm2 tab to the foreground given the tty path of the process running in it.
// Falls back to Terminal.app if iTerm isn't running.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function ttyShort(tty) {
  if (!tty) return null;
  // /dev/ttys000 → ttys000
  return tty.replace(/^\/dev\//, "");
}

// Find the iTerm session whose tty matches, then:
//   1. de-miniaturize its window (in case it was minimized)
//   2. select the tab + session inside that window
//   3. activate iTerm AFTER selection so the correct window/tab is foreground
//   4. raise the window to front explicitly via `index` reset
const ITERM_SCRIPT = (tty) => `
on run
  set ttyTarget to "${tty}"
  tell application "iTerm"
    set targetWindow to missing value
    set targetTab to missing value
    set targetSession to missing value
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          try
            set tn to tty of s
            if tn is equal to ttyTarget or tn ends with ttyTarget then
              set targetWindow to w
              set targetTab to t
              set targetSession to s
              exit repeat
            end if
          end try
        end repeat
        if targetSession is not missing value then exit repeat
      end repeat
      if targetSession is not missing value then exit repeat
    end repeat
    if targetSession is missing value then return false
    try
      if miniaturized of targetWindow then set miniaturized of targetWindow to false
    end try
    try
      tell targetTab to select
    end try
    try
      select targetSession
    end try
    try
      set index of targetWindow to 1
    end try
    activate
    return true
  end tell
end run
`;

const TERMINAL_SCRIPT = (tty) => `
tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      try
        if (tty of t) is "${tty}" then
          set selected tab of w to t
          set frontmost of w to true
          return true
        end if
      end try
    end repeat
  end repeat
end tell
return false
`;

export async function focusTty(tty) {
  if (!tty) return { ok: false, reason: "no-tty" };
  const short = ttyShort(tty);

  // Try iTerm first
  try {
    const { stdout } = await exec("/usr/bin/osascript", ["-e", ITERM_SCRIPT(short)]);
    if (stdout.trim() === "true") return { ok: true, app: "iTerm" };
  } catch {
    /* fall through */
  }

  // Fallback to Terminal.app (uses full path)
  try {
    const { stdout } = await exec("/usr/bin/osascript", ["-e", TERMINAL_SCRIPT(tty)]);
    if (stdout.trim() === "true") return { ok: true, app: "Terminal" };
  } catch {
    /* fall through */
  }

  return { ok: false, reason: "tab-not-found" };
}
