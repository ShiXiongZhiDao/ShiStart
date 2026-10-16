/**
 * 赞助二维码的镜像源选择。
 *
 * 三张图（支付宝收款码 / 微信收款码 / 公众号二维码）放在 GitHub 与 Gitee 两处，
 * 打开「关于」时**同时探两个源，谁先加载成功就用谁的** —— 国内外网络对这两个源的
 * 可达性差别很大，写死任何一个都会让一部分人看到空白。
 *
 * ## 为什么这里不需要任何权限（实测过的，别再"顺手补一条 host_permissions"）
 *
 * 本扩展的 `permissions` 只有 bookmarks / favicon / storage / alarms，**没有**
 * `host_permissions`；真机实测在 `origins: []` 的情况下，扩展页 `new Image()` 加载
 * 这两个源都成功（GitHub 约 1.0s、Gitee 约 1.2s）。MV3 的 host 权限管的是
 * fetch/XHR，不拦 `<img>` 这种子资源；默认 CSP（`script-src 'self'; object-src 'self'`）
 * 也没有限制 `img-src`。**所以别为了这几张图去申请权限** —— 那是白给用户加一条
 * 安装警告。
 *
 * ## 探测只探一张图
 *
 * 每次打开多两个请求已经是上限了，不值得为"三个字段分别验"发六个请求：支付宝那张
 * 能加载，就认为这个源整体可用（三张图在同一个仓库同一个目录，不存在"只有一张通"的
 * 现实场景）。**真的出现了单张 404，由显示端逐张回落兜住**（见 QrTile）。
 */

export interface QrMirror {
  id: 'github' | 'gitee';
  /** 探测用地址（取支付宝那张），也代表这个源通不通。 */
  probeUrl: string;
  alipay: string;
  wechatPay: string;
  wechatOfficial: string;
}

/** 二维码在仓库里的目录；两边目录结构一致，只换域名。 */
const GITHUB_DIR = 'https://raw.githubusercontent.com/ShiXiongZhiDao/ShiTab/main/public/qr';
// Gitee 的 raw 链接会 302 跳到 raw.giteeusercontent.com 的签名地址（每次请求现签），
// 所以这里**必须写原始 URL** —— 把跳转后的地址抄下来会过期。
const GITEE_DIR = 'https://gitee.com/ShiXiongZhiDao/ShiTab/raw/main/public/qr';

export const QR_MIRRORS: readonly QrMirror[] = [
  {
    id: 'github',
    probeUrl: `${GITHUB_DIR}/alipay.png`,
    alipay: `${GITHUB_DIR}/alipay.png`,
    wechatPay: `${GITHUB_DIR}/wechat-pay.png`,
    wechatOfficial: `${GITHUB_DIR}/wechat-official.png`,
  },
  {
    id: 'gitee',
    probeUrl: `${GITEE_DIR}/alipay.png`,
    alipay: `${GITEE_DIR}/alipay.png`,
    wechatPay: `${GITEE_DIR}/wechat-pay.png`,
    wechatOfficial: `${GITEE_DIR}/wechat-official.png`,
  },
];

export const PROBE_TIMEOUT_MS = 4000;

/**
 * 探一张图能不能加载。成功 resolve，失败或**超时** reject。
 *
 * 超时按失败处理：一个迟迟不返回的地址比一个明确报错的地址更耽误人 —— 用户看到的
 * 是长时间空白。
 */
export function probeImage(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    // node 环境（单测）里没有 Image；那时明确失败，让调用方走"不可用"分支，
    // 而不是抛一个 TypeError 把上层炸掉。
    if (typeof Image === 'undefined') {
      reject(new Error(`当前环境没有 Image：${url}`));
      return;
    }
    const image = new Image();
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (success) resolve();
      else reject(new Error(`图片源不可用：${url}`));
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/**
 * 选出可用的镜像：**并发探，谁先成功用谁**（不是"探通了再比速度"—— 那要多一轮）。
 *
 * 全部失败时返回 **null**，不返回"默认源"：返回默认源等于告诉调用方"有图"，
 * 而实际上一张也加载不出来，那正是"看起来一切正常"的静默失败。明确返回 null，
 * 由显示端说"加载不出来"。
 */
export async function chooseQrMirror(timeoutMs = PROBE_TIMEOUT_MS): Promise<QrMirror | null> {
  try {
    return await Promise.any(
      QR_MIRRORS.map(async (mirror) => {
        await probeImage(mirror.probeUrl, timeoutMs);
        return mirror;
      }),
    );
  } catch {
    return null;
  }
}

/**
 * 一个字段的候选地址列表：**选中的源排第一，其余跟在后面**。
 *
 * 顺序就是回落的顺序 —— 探测时的胜者未必每张图都通（单张 404 / 被缓存污染），
 * 显示端按这个列表一张张退。没选出源时按 QR_MIRRORS 原序试。
 */
export function qrUrls(
  mirror: QrMirror | null,
  field: 'alipay' | 'wechatPay' | 'wechatOfficial',
): string[] {
  const ordered = mirror
    ? [mirror, ...QR_MIRRORS.filter((item) => item.id !== mirror.id)]
    : [...QR_MIRRORS];
  return ordered.map((item) => item[field]);
}
