/**
 * 一个够用的 XML 扫描器 —— **不用 DOMParser**。
 *
 * 为什么自己写：同步跑在 MV3 的 background service worker 里，而 DOMParser 不在
 * Worker 全局里。用了它，表现不是"报错"，是列目录那一步抛 ReferenceError 被
 * catch 咽掉，于是"远端永远是空的" —— 去重失效、每轮都重复上传。
 * 而单测跑在 jsdom 里是有 DOMParser 的，所以这个缺陷在测试里根本不会暴露。
 *
 * 因此这里刻意做成纯字符串处理：在 node 环境也能跑，配套用例就在 node 里跑。
 *
 * 只实现 PROPFIND 需要的子集：元素嵌套、自闭合、实体引用；跳过注释 / `<?…?>` / `<!DOCTYPE>`。
 * 不认命名空间前缀 —— 各家写法不同（`d:` / `D:` / 无前缀 / 全大写），
 * 一律先成树再按**本地标签名**筛，否则换台服务器就会"列目录成功但一条都没看见"。
 */

/** 文本节点的标签名。`#` 不是合法的 XML 名字符，不会和任何真实标签撞上。 */
export const TEXT_NODE = '#text';

export interface XmlNode {
  /** 去掉前缀并转小写的标签名。`D:href` 与 `href` 与 `HREF` 都是 `href`。 */
  local: string;
  children: XmlNode[];
  /** 直接文本（已解实体）。取值一律走 textOf()。 */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function localPart(qname: string): string {
  const colon = qname.indexOf(':');
  return (colon === -1 ? qname : qname.slice(colon + 1)).toLowerCase();
}

interface OpenTag {
  local: string;
  selfClosing: boolean;
  end: number;
}

/** 标签切分。属性段按引号感知地吃掉，避免 `<d:href a="x>y">` 把元素提前截断。 */
function readOpenTag(xml: string, from: number): OpenTag | undefined {
  let at = from + 1;
  const nameStart = at;
  while (at < xml.length && /[\w:.-]/.test(xml[at] ?? '')) at += 1;
  const rawName = xml.slice(nameStart, at);
  if (!rawName) return undefined;

  let cursor = at;
  let quote = '';
  while (cursor < xml.length) {
    const char = xml[cursor];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      break;
    }
    cursor += 1;
  }
  if (cursor >= xml.length) return undefined;

  return { local: localPart(rawName), selfClosing: xml[cursor - 1] === '/', end: cursor + 1 };
}

/** 解析出根元素。返回 undefined = "这不是一个能用的 XML 文档"，交给调用方按坏响应处理。 */
export function parseXmlRoot(xml: string): XmlNode | undefined {
  const root: XmlNode = { local: '#document', children: [], text: '' };
  const stack: XmlNode[] = [root];
  let cursor = 0;

  while (cursor < xml.length) {
    const lt = xml.indexOf('<', cursor);
    if (lt === -1) break;
    const open = stack[stack.length - 1];
    const text = xml.slice(cursor, lt);
    if (text && open) {
      // 非空文本也建成节点：这样"文本在子元素前后"的位置信息不会丢。
      // 纯缩进空白就还挂在父节点的 text 上，免得污染 children。
      if (text.trim() === '') open.text += decodeEntities(text);
      else open.children.push({ local: TEXT_NODE, children: [], text: decodeEntities(text) });
    }

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt);
      cursor = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt);
      cursor = close === -1 ? xml.length : close + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const close = xml.indexOf('>', lt);
      cursor = close === -1 ? xml.length : close + 1;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      const close = xml.indexOf('>', lt);
      if (close === -1) return undefined;
      const name = localPart(xml.slice(lt + 2, close).trim());
      const top = stack[stack.length - 1];
      if (stack.length <= 1 || !top || top.local !== name) return undefined;
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const tag = readOpenTag(xml, lt);
    if (!tag) return undefined;
    const node: XmlNode = { local: tag.local, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (!parent) return undefined;
    parent.children.push(node);
    if (!tag.selfClosing) stack.push(node);
    cursor = tag.end;
  }

  // 有没闭合的元素 ⇒ 半截文档
  if (stack.length > 1) return undefined;
  return root.children[0];
}

export function childrenByLocal(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((child) => child.local === local);
}

/**
 * 按**文档顺序**（前序 DFS）收集所有匹配的后代。
 *
 * 顺序是语义的一部分，不能随便：`textOf` 取的是第一个匹配，
 * 而 PROPFIND 的 response 列表顺序就是远端的排列顺序。用栈 pop 会把兄弟节点倒过来。
 */
export function descendantsByLocal(node: XmlNode, local: string): XmlNode[] {
  const found: XmlNode[] = [];
  const stack: XmlNode[] = [...node.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.local === local) found.push(current);
    // 倒着压栈，弹出来才是正序。
    for (let at = current.children.length - 1; at >= 0; at -= 1) {
      const child = current.children[at];
      if (child) stack.push(child);
    }
  }
  return found;
}

/** 收集一个节点下所有后代文本（前序，混合内容也保持顺序）。 */
function allText(node: XmlNode): string {
  let out = node.text;
  for (const child of node.children) out += allText(child);
  return out;
}

/**
 * 文档顺序里第一个匹配后代的文本。
 * **空文本与缺失统一返回 undefined** —— 别拿 '' 当"有值"：
 * `<D:resourcetype/>` 这种空元素在 PROPFIND 里到处都是，
 * 返回 '' 会让上层以为拿到了一个空的 ETag 并拿它去做条件写。
 */
export function textOf(node: XmlNode, local: string): string | undefined {
  const [found] = descendantsByLocal(node, local);
  if (!found) return undefined;
  const text = allText(found).trim();
  return text === '' ? undefined : text;
}
