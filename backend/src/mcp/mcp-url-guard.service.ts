import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * MCP 目标地址安全校验（SSRF 防护）。
 *
 * 相比工作流 HTTP 节点的 SsrfCheckService，这里更严格：
 *  1. 协议白名单（http / https）；
 *  2. 禁止 URL 内嵌认证信息（user:pass@host）——会被写进日志/错误信息；
 *  3. 主机名黑名单（localhost / *.local / *.internal / metadata 等）；
 *  4. IP 字面量与 **DNS 解析结果** 都要过私网/保留地址检查，
 *     防止攻击者把自己的域名 A 记录指向 127.0.0.1（DNS 重绑定）；
 *  5. 传输层禁止自动跟随重定向，302 到内网同样会被拦下。
 *
 * 说明：MCP Server URL 由用户配置，属于外部目标地址，必须按不可信输入处理。
 */
@Injectable()
export class McpUrlGuardService {
  private readonly logger = new Logger(McpUrlGuardService.name);

  /** 解析结果短缓存，避免同一 URL 在多次请求里重复 DNS 查询 */
  private readonly dnsCache = new Map<
    string,
    { expiresAt: number; addresses: string[] }
  >();
  private readonly DNS_CACHE_TTL_MS = 30_000;

  /** 明确禁止的主机名后缀 */
  private readonly blockedHostSuffixes = [
    '.local',
    '.localhost',
    '.internal',
    '.intranet',
    '.corp',
    '.home',
    '.lan',
  ];

  /** 云厂商 metadata / 内部服务常见主机名 */
  private readonly blockedHosts = new Set([
    'localhost',
    'metadata',
    'metadata.google.internal',
    'instance-data',
    'kubernetes.default',
    'kubernetes.default.svc',
  ]);

  /**
   * 同步校验（仅字符串层面，不解析 DNS）。
   * 用于创建/更新配置时的快速失败。
   */
  assertSafeUrlShape(urlString: string): void {
    const parsed = this.parse(urlString);

    if (parsed.username || parsed.password) {
      throw new BadRequestException(
        'MCP Server URL 不允许内嵌用户名/密码，请使用 Authentication 配置认证信息',
      );
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) {
      throw new BadRequestException('MCP Server URL 缺少主机名');
    }

    if (this.blockedHosts.has(host)) {
      throw new BadRequestException(`禁止访问内部主机：${host}`);
    }
    if (this.blockedHostSuffixes.some((suffix) => host.endsWith(suffix))) {
      throw new BadRequestException(`禁止访问内部域名：${host}`);
    }

    // IP 字面量直接判定
    if (isIPv4(host)) {
      if (this.isBlockedIpv4(host)) {
        throw new BadRequestException(`禁止访问内网/保留地址：${host}`);
      }
      return;
    }
    if (isIPv6(host)) {
      if (this.isBlockedIpv6(host)) {
        throw new BadRequestException(`禁止访问内网/保留地址：${host}`);
      }
      return;
    }
  }

  /**
   * 完整校验：字符串层面 + DNS 解析后的每个 IP。
   * 传输层在每次发起请求前调用。
   */
  async assertSafeUrl(urlString: string): Promise<void> {
    this.assertSafeUrlShape(urlString);

    const parsed = this.parse(urlString);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isIPv4(host) || isIPv6(host)) return; // IP 字面量已在上面判定过

    const addresses = await this.resolve(host);
    if (addresses.length === 0) {
      throw new BadRequestException(`无法解析 MCP Server 域名：${host}`);
    }

    for (const address of addresses) {
      const normalized = this.normalizeMappedAddress(address);
      if (isIPv4(normalized) && this.isBlockedIpv4(normalized)) {
        this.logger.warn(
          `MCP 域名 ${host} 解析到受限地址 ${address}，已拒绝连接（疑似 DNS 重绑定）`,
        );
        throw new BadRequestException(
          `MCP Server 域名 ${host} 解析到内网/保留地址，已拒绝连接`,
        );
      }
      if (isIPv6(normalized) && this.isBlockedIpv6(normalized)) {
        this.logger.warn(
          `MCP 域名 ${host} 解析到受限地址 ${address}，已拒绝连接（疑似 DNS 重绑定）`,
        );
        throw new BadRequestException(
          `MCP Server 域名 ${host} 解析到内网/保留地址，已拒绝连接`,
        );
      }
    }
  }

  // ===========================================================================
  // 内部实现
  // ===========================================================================

  private parse(urlString: string): URL {
    if (!urlString || typeof urlString !== 'string') {
      throw new BadRequestException('MCP Server URL 不能为空');
    }
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      throw new BadRequestException(`MCP Server URL 格式无效：${urlString}`);
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new BadRequestException(
        `不支持的协议 ${protocol}，MCP Server URL 仅允许 http / https`,
      );
    }
    return parsed;
  }

  private async resolve(host: string): Promise<string[]> {
    const cached = this.dnsCache.get(host);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;

    try {
      const records = await dns.lookup(host, { all: true });
      const addresses = records.map((r) => r.address);
      this.dnsCache.set(host, {
        addresses,
        expiresAt: Date.now() + this.DNS_CACHE_TTL_MS,
      });
      return addresses;
    } catch (err) {
      throw new BadRequestException(
        `无法解析 MCP Server 域名 ${host}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** ::ffff:127.0.0.1 → 127.0.0.1 */
  private normalizeMappedAddress(address: string): string {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:') && isIPv4(lower.slice(7))) {
      return lower.slice(7);
    }
    return address;
  }

  private isBlockedIpv4(ip: string): boolean {
    const value = ipv4ToInt(ip);
    if (value === null) return true;

    const inRange = (cidr: string): boolean => {
      const [base, bitsStr] = cidr.split('/');
      const baseInt = ipv4ToInt(base);
      if (baseInt === null) return false;
      const bits = Number(bitsStr);
      if (bits === 0) return true;
      const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
      return (value & mask) === (baseInt & mask);
    };

    return [
      '0.0.0.0/8', // 本机/未指定
      '10.0.0.0/8', // 私有
      '100.64.0.0/10', // 运营商级 NAT
      '127.0.0.0/8', // 环回
      '169.254.0.0/16', // 链路本地（含云 metadata）
      '172.16.0.0/12', // 私有
      '192.0.0.0/24', // IETF 协议保留
      '192.0.2.0/24', // TEST-NET-1
      '192.88.99.0/24', // 6to4 中继
      '192.168.0.0/16', // 私有
      '198.18.0.0/15', // 基准测试
      '198.51.100.0/24', // TEST-NET-2
      '203.0.113.0/24', // TEST-NET-3
      '224.0.0.0/4', // 组播
      '240.0.0.0/4', // 保留
    ].some(inRange);
  }

  private isBlockedIpv6(ip: string): boolean {
    const bytes = expandIpv6(ip);
    if (!bytes) return true;

    // :: / ::1
    if (bytes.every((b) => b === 0)) return true;
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1)
      return true;

    // fc00::/7 ULA
    if ((bytes[0] & 0xfe) === 0xfc) return true;
    // fe80::/10 链路本地
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
    // ff00::/8 组播
    if (bytes[0] === 0xff) return true;
    // 2001:db8::/32 文档地址
    if (
      bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8
    ) {
      return true;
    }
    // 2001::/32 Teredo
    if (
      bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x00
    ) {
      return true;
    }
    // 64:ff9b::/96 NAT64 —— 内嵌 IPv4
    const nat64Prefix = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
    if (nat64Prefix.every((b, i) => bytes[i] === b)) {
      return this.isBlockedIpv4(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }
    // 2002::/16 6to4 —— 内嵌 IPv4
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
      return this.isBlockedIpv4(
        `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`,
      );
    }
    // ::ffff:a.b.c.d IPv4 映射
    if (
      bytes.slice(0, 10).every((b) => b === 0) &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff
    ) {
      return this.isBlockedIpv4(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }

    return false;
  }
}

function ipv4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const parts = ip.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return null;
  }
  return (
    (((parts[0] << 24) >>> 0) +
      ((parts[1] << 16) >>> 0) +
      ((parts[2] << 8) >>> 0) +
      parts[3]) >>>
    0
  );
}

/** 把 IPv6 字符串展开成 16 字节；非法输入返回 null */
function expandIpv6(input: string): number[] | null {
  let ip = input.trim();
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
  ip = ip.toLowerCase();

  // 处理内嵌 IPv4
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = ip.slice(lastColon + 1);
    if (!isIPv4(ipv4)) return null;
    const parts = ipv4.split('.').map((p) => Number(p));
    const g1 = (((parts[0] << 8) | parts[1]) >>> 0).toString(16);
    const g2 = (((parts[2] << 8) | parts[3]) >>> 0).toString(16);
    ip = `${ip.slice(0, lastColon)}:${g1}:${g2}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const toGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const groups: number[] = [];
    for (const group of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  if (!head) return null;
  const tail = halves.length === 2 ? toGroups(halves[1]) : null;
  if (halves.length === 2 && !tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    const zeros = 8 - head.length - (tail?.length ?? 0);
    if (zeros < 0) return null;
    groups = [...head, ...Array<number>(zeros).fill(0), ...(tail ?? [])];
  } else {
    groups = head;
  }

  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}
