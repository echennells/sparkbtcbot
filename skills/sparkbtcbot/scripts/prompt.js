// Hidden/echoed stderr prompt, shared by setup and reveal-mnemonic. Prompts on
// stderr (readline defaults to stdout, which is wrong for secrets). Two paths:
//   TTY: raw mode so the terminal does not echo — a `hidden` passphrase must
//        never appear on screen or in pty recordings (tmux/asciinema/script);
//        visible input is echoed exactly once by us.
//   pipe/CI: line-buffered with a carry buffer — piped input delivers several
//        lines in one chunk, and whatever follows the submitted line must feed
//        the NEXT prompt, not vanish with this one's listener.
import { stdin, stderr, exit } from "node:process";

let pendingInput = "";

export async function promptStderr(question, { hidden = false } = {}) {
  stderr.write(question);
  return stdin.isTTY ? promptRawTty(hidden) : promptPipedLine();
}

function promptPipedLine() {
  return new Promise((resolve, reject) => {
    const takeLine = () => {
      const nl = pendingInput.search(/[\r\n]/);
      if (nl === -1) return null;
      const line = pendingInput.slice(0, nl);
      const crlf = pendingInput[nl] === "\r" && pendingInput[nl + 1] === "\n";
      pendingInput = pendingInput.slice(nl + (crlf ? 2 : 1));
      return line;
    };
    const buffered = takeLine();
    if (buffered !== null) { stderr.write("\n"); resolve(buffered); return; }
    const onData = (chunk) => {
      pendingInput += chunk.toString();
      const line = takeLine();
      if (line !== null) {
        stdin.pause();
        stdin.removeListener("data", onData);
        stderr.write("\n");
        resolve(line);
      }
    };
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("error", reject);
    stdin.resume();
  });
}

function promptRawTty(hidden) {
  return new Promise((resolve, reject) => {
    let input = "";
    let esc = false; // swallow escape sequences (arrow keys etc.)
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    const done = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      resolve(value);
    };
    const consume = (data) => {
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (esc) { if (/[a-zA-Z~]/.test(ch)) esc = false; continue; }
        if (ch === "\x1b") { esc = true; continue; }
        if (ch === "\r" || ch === "\n") {
          pendingInput += data.slice(i + (ch === "\r" && data[i + 1] === "\n" ? 2 : 1));
          done(input);
          return true;
        }
        if (ch === "\x03") { // Ctrl-C — raw mode means we handle it ourselves
          stdin.setRawMode(false);
          stderr.write("\n");
          exit(130);
        }
        if (ch === "\x7f" || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            if (!hidden) stderr.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // other control chars
        input += ch;
        if (!hidden) stderr.write(ch); // raw mode: the tty no longer echoes, we do — once
      }
      return false;
    };
    const onData = (data) => { consume(data); };
    // A previous prompt may have carried over pasted-ahead input — drain it first.
    if (pendingInput) {
      const carried = pendingInput;
      pendingInput = "";
      if (consume(carried)) return;
    }
    stdin.on("data", onData);
    stdin.once("error", (e) => { stdin.setRawMode(false); reject(e); });
    stdin.resume();
  });
}
