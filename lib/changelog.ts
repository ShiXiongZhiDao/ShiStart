/**
 * `CHANGELOG.md` 的解析（纯函数）。
 *
 * 为什么要有这个文件：版本号与变更日志是**两处真值**，而它们天生会漂 ——
 * 改了 `package.json` 忘了写日志、或者写了日志忘了升版本，都是"对外说的话与
 * 手里发的东西不一致"。把这个解析抽出来，就能用一条单测把两者钉在一起
 * （见 `lib/changelog.test.ts` 里那条守卫）。
 *
 * 只解析 `## x.y.z` 这一种标题。其余二级标题（"只记对外能感知的变化"之类）
 * 一律不是版本段 —— 认不出来就当它不存在，不猜。
 */

export interface ChangelogRelease {
  version: string;
  /** ISO 日期（`2026-10-16`）。标题里没写就是 null，绝不拿"今天"去填。 */
  date: string | null;
  /** 这一版标题下面的正文，已去掉两端空行。 */
  body: string;
}

/** `## 1.1.0 — 2026-10-16`，日期可省。破折号两侧允许多个空格。 */
const RELEASE_HEADING = /^##\s+(\d+\.\d+\.\d+)(?:\s*[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

const ANY_HEADING = /^##\s+/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let lines: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    current.body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    releases.push(current);
    current = null;
    lines = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const matched = RELEASE_HEADING.exec(line);
    if (matched) {
      flush();
      current = { version: matched[1] ?? '', date: matched[2] ?? null, body: '' };
      continue;
    }
    if (ANY_HEADING.test(line)) {
      // 另一个二级标题：这一段结束了（但不能开新的一段 —— 它不是版本）。
      flush();
      continue;
    }
    if (current !== null) lines.push(line);
  }
  flush();

  return releases;
}

/** 最新的一版（文件里写在最前面的那个）。没有版本段就是 null。 */
export function latestRelease(markdown: string): ChangelogRelease | null {
  return parseChangelog(markdown)[0] ?? null;
}

export function findRelease(markdown: string, version: string): ChangelogRelease | null {
  return parseChangelog(markdown).find((release) => release.version === version) ?? null;
}

/** 三段数字的语义化版本，其余（分支名、`1.1`、`v1.1.0`）一律不算。 */
export function isReleaseVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/**
 * 剥掉行内 Markdown 标记（`**加粗**` 与 `` `代码` ``）。
 *
 * 「关于」那块是**纯文本渲染**，不认这些记号 —— 星号原样留在屏幕上就是
 * "句子中间插着两个星号"（真机截图抓出来的）。仓库里的 CHANGELOG 仍保留 Markdown，
 * 所以在解析这一侧剥，而不是逼着日志写成无强调的平文。
 */
function stripInline(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '');
}

export interface ReleaseSection {
  /** `### ` 那一行（"新增" / "变化" / "修复"）。 */
  title: string;
  items: string[];
}

/**
 * 把一版的正文拆成"几个小节、每节若干条"，给「关于」页那一小块用。
 *
 * 只认 `###` 与 `- ` 两种标记：CHANGELOG 是给人读的 Markdown，不值得为它
 * 引一个渲染器。
 *
 * **续行接上一条，不另起一条**。日志里的条目常常为了排版折成两三行（Markdown 里
 * 折行不需要缩进），而界面上**一条 = 一个 `<li>`** —— 每行都成条的话，界面上会
 * 出现一串没头没尾的碎片（"随书签一起走你填的那个空间。"自成一条）。
 * 认不出形态的行一律接到上一条后面，宁可接错也不丢 —— 丢掉等于界面上少说一件事，
 * 那正是这个文件存在的反面。
 */
export function parseReleaseSections(body: string): ReleaseSection[] {
  const sections: ReleaseSection[] = [];

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('### ')) {
      sections.push({ title: stripInline(trimmed.slice(4).trim()), items: [] });
      continue;
    }

    const text = stripInline(trimmed.replace(/^[-*]\s*/, ''));
    const last = sections[sections.length - 1];
    const previous = last?.items[last.items.length - 1];

    if (last === undefined || /^[-*]\s/.test(trimmed) || previous === undefined) {
      // 新条目；或者 `###` 之后直接来了一段没有 `- ` 的话 —— 单开一条，不丢。
      if (last === undefined) sections.push({ title: '', items: [text] });
      else last.items.push(text);
      continue;
    }

    last.items[last.items.length - 1] = `${previous} ${text}`;
  }

  return sections.filter((section) => section.items.length > 0 || section.title !== '');
}

/** 语义化版本的三段比较：`a > b` 返回正数。 */
export function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
