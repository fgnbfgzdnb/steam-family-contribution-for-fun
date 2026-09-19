/*!
 * 路径闸门 —— 用户给的 `--from` / `--out` / `--html` 这类路径，统一从这里过一遍。
 *
 * 为什么要有这个文件：这些路径是可以从命令行传进来的。对「自己给自己传路径」来说
 * 本来没什么可防的（能读那个文件的人本来就能读），但这个工具是要**发给别人跑**的，
 * 所以把「只碰当前目录里的东西」做成一条件硬规则，比讲道理省事：
 *   · 读取（`--from` / `cli.js` 的数据文件）只允许 .json，且必须落在当前目录内
 *   · 写入（`--out` / `--html`）只允许 .html / .htm，且必须落在当前目录内
 *   · 打开浏览器前再查一遍（见 steam-family.js 的 openInBrowser）
 *
 * ★ 它挡的是什么、不挡什么，说清楚：
 *   挡的是「命令行里的路径指向当前目录以外」——目录穿越（`../`）、绝对路径、
 *   其它盘符、控制字符 / NUL。
 *   **不挡**软链：如果当前目录里本身有一个软链指向外面，那是运行者自己布的环境。
 *   也不打算挡：`fs.realpath` 在 cwd 本身经过软链时（macOS 的 /tmp → /private/tmp）
 *   会把正常路径判成越界，误伤的代价比收益大。
 */
'use strict';

const path = require('path');

/** 控制字符（含 NUL）：路径里有这些基本就是构造出来的，直接拒。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 把用户给的路径解析成绝对路径，并确保它落在 `process.cwd()` 里。
 *
 * @param {string} input 用户给的原始路径
 * @param {string[]} exts 允许的扩展名（小写、带点）。空数组 = 不限制
 * @param {string} label 报错时怎么称呼它（例如 `--out`）
 * @returns {string} 绝对路径
 */
function resolveInsideCwd(input, exts, label) {
  const raw = String(input == null ? '' : input);
  const who = label || '路径';

  if (!raw.trim()) throw new Error(who + '不能是空的');
  if (CONTROL_CHARS.test(raw)) throw new Error(who + '里含有控制字符，拒绝处理');

  const cwd = process.cwd();
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);

  // 不在 cwd 内：`..` 开头（往上跑）、或跨盘符时 relative 会返回绝对路径
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(who + '必须落在当前目录里（或它的子目录），不能指向外面：' + raw +
      '\n  （这是有意的限制：这个工具只读写当前目录里的文件。' +
      '\n    想放到别处，就先 cd 过去再跑，或者先把文件拷进来。）');
  }

  if (exts && exts.length) {
    const ext = path.extname(abs).toLowerCase();
    if (exts.indexOf(ext) < 0) {
      throw new Error(who + '的扩展名只能是 ' + exts.join(' / ') +
        '，实际是 ' + (ext || '（没有扩展名）') + '：' + raw);
    }
  }

  return abs;
}

/** 读取用：只认 .json */
function resolveInputFile(input, label) {
  return resolveInsideCwd(input, ['.json'], label);
}

/** 写出用：只认 .html / .htm */
function resolveOutputFile(input, label) {
  return resolveInsideCwd(input, ['.html', '.htm'], label);
}

/** 这个绝对路径能不能交出去打开（只读判断，不抛错） */
function isOpenableReport(absPath) {
  const cwd = process.cwd();
  const p = path.resolve(String(absPath == null ? '' : absPath));
  const rel = path.relative(cwd, p);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const ext = path.extname(p).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

module.exports = { resolveInsideCwd, resolveInputFile, resolveOutputFile, isOpenableReport };
