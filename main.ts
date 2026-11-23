// tiny-stack-vm: an interpreter for make.fun's tiny stack ISA (v1), written for the
// tiny-stack-vm-01 bounty. One run answers every instance under /input: for each <id> it
// executes program.bin against input.bin and writes /output/<id>/stdout.bin plus
// /output/<id>/exit.txt. Machine: 32-bit wrapping integers, a 256-deep data stack, a
// 64-deep call stack, 256 words of memory, at most 1,000,000 steps and 65,536 output
// bytes per program; every fault ends the program with its trap code as the exit code.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Stack effect of each opcode byte, as two digit strings indexed by the byte: how many
// values it pops and how many it leaves. Slots for bytes that name no opcode are 0 and
// never used: an unknown byte traps before these are read.
const POPS =
  '00011223' + '00000000' + '22222221' + '22212220' + '22200000' + '00000000' +
  '01100000' + '00000000' + '12000000' + '00000000' + '1101';
const PUSH =
  '01102233' + '00000000' + '11111111' + '11111110' + '11100000' + '00000000' +
  '00000000' + '00000000' + '10000000' + '00000000' + '0010';

// Runs one program to its end; returns [output bytes, exit code].
function run(P, I) {
  const S = new Int32Array(256); // data stack
  const C = new Int32Array(64); // return addresses
  const M = new Int32Array(256); // memory, starts zeroed
  const O = new Uint8Array(65536); // everything the program writes
  let sp = 0, cp = 0, pc = 0, steps = 0, inp = 0, len = 0;
  const n = P.length;
  const fin = (code) => [O.subarray(0, len), code];
  for (;;) {
    if (steps >= 1000000) return fin(10); // step limit
    if (pc < 0 || pc >= n) return fin(9); // pc outside the program
    const op = P[pc];
    // Immediate length, or -1 when the byte names no opcode.
    let im;
    if (op < 8) im = op === 1 ? 1 : op === 2 ? 4 : 0;
    else if (op >= 16 && op <= 30) im = 0;
    else if (op >= 32 && op <= 34) im = 0;
    else if (op >= 48 && op <= 51) im = 2;
    else if (op === 52 || op === 64 || op === 65 || (op >= 80 && op <= 83)) im = 0;
    else return fin(5); // unknown opcode
    if (pc + im >= n) return fin(9); // immediate cut off by the program's end
    steps++;
    if (sp < +POPS[op]) return fin(2); // stack underflow
    if (sp - +POPS[op] + +PUSH[op] > 256) return fin(3); // stack overflow
    const nx = pc + 1 + im; // address of the next instruction
    pc = nx;
    switch (op) {
      case 0x00: // HALT
        return fin(0);
      case 0x01: // PUSH8, sign-extended
        S[sp++] = (P[nx - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian
        S[sp++] = P[nx - 4] | (P[nx - 3] << 8) | (P[nx - 2] << 16) | (P[nx - 1] << 24);
        break;
      case 0x03: // POP
        sp--;
        break;
      case 0x04: // DUP
        S[sp] = S[sp - 1];
        sp++;
        break;
      case 0x05: { // SWAP
        const t = S[sp - 1];
        S[sp - 1] = S[sp - 2];
        S[sp - 2] = t;
        break;
      }
      case 0x06: // OVER
        S[sp] = S[sp - 2];
        sp++;
        break;
      case 0x07: { // ROT: ( a b c -- b c a )
        const t = S[sp - 3];
        S[sp - 3] = S[sp - 2];
        S[sp - 2] = S[sp - 1];
        S[sp - 1] = t;
        break;
      }
      case 0x17: // NEG, wraps
        S[sp - 1] = -S[sp - 1];
        break;
      case 0x1b: // NOT
        S[sp - 1] = ~S[sp - 1];
        break;
      case 0x30: // JMP
      case 0x31: // JZ
      case 0x32: { // JNZ
        const rel = ((P[nx - 2] | (P[nx - 1] << 8)) << 16) >> 16;
        let go = true;
        if (op !== 0x30) {
          const v = S[--sp];
          go = op === 0x31 ? v === 0 : v !== 0;
        }
        if (go) pc = nx + rel;
        break;
      }
      case 0x33: // CALL, to the unsigned absolute address in the immediate
        if (cp >= 64) return fin(7);
        C[cp++] = nx;
        pc = P[nx - 2] | (P[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return fin(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = S[sp - 1];
        if (a < 0 || a > 255) return fin(6);
        S[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE: ( v addr -- )
        const a = S[sp - 1];
        if (a < 0 || a > 255) return fin(6);
        M[a] = S[sp - 2];
        sp -= 2;
        break;
      }
      case 0x50: { // PRINT, the value in decimal ASCII
        const s = String(S[sp - 1]);
        if (len + s.length > 65536) return fin(11); // would pass the output limit
        sp--;
        for (let i = 0; i < s.length; i++) O[len++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC, one byte
        if (len >= 65536) return fin(11);
        O[len++] = S[--sp] & 255;
        break;
      case 0x52: // IN, -1 once the input is used up
        S[sp++] = inp < I.length ? I[inp++] : -1;
        break;
      case 0x53: // EXIT, with the low byte of the value
        return fin(S[sp - 1] & 255);
      default: { // the binary operators: ( a b -- r )
        const b = S[sp - 1];
        const a = S[sp - 2];
        let r;
        if (op === 0x10) r = a + b;
        else if (op === 0x11) r = a - b;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { if (b === 0) return fin(4); r = (a / b) | 0; }
        else if (op === 0x14) { if (b === 0) return fin(4); r = a % b; }
        else if (op === 0x15) { if (b === 0) return fin(4); r = Math.floor((a >>> 0) / (b >>> 0)); }
        else if (op === 0x16) { if (b === 0) return fin(4); r = (a >>> 0) % (b >>> 0); }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = a >>> (b & 31);
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // 0x22 LTU
        S[sp - 2] = r;
        sp--;
      }
    }
  }
}

// The sandbox names the mounts through these two variables (in its container they are
// /input and /output themselves); the literal paths are the fallback.
const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(IN_DIR).sort()) {
  const [out, code] = run(
    readFileSync(IN_DIR + '/' + id + '/program.bin'),
    readFileSync(IN_DIR + '/' + id + '/input.bin'),
  );
  mkdirSync(OUT_DIR + '/' + id, { recursive: true });
  writeFileSync(OUT_DIR + '/' + id + '/stdout.bin', out);
  writeFileSync(OUT_DIR + '/' + id + '/exit.txt', code + '\n');
}
