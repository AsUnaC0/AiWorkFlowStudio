import { Injectable, BadRequestException } from '@nestjs/common';
import { URL } from 'url';

/**
 * SSRF 防护服务
 *
 * HTTP 节点会主动访问用户指定的 URL，必须防止：
 * - 访问 localhost / 127.0.0.1 等本地地址
 * - 访问内网 IP（10.x.x.x, 172.16-31.x.x, 192.168.x.x）
 * - 使用 file:// 等危险协议
 * - 使用非 http/https 协议
 */
@Injectable()
export class SsrfCheckService {
  /**
   * 校验 URL 是否安全
   * @throws BadRequestException 如果 URL 不安全
   */
  validate(urlString: string): void {
    if (!urlString || typeof urlString !== 'string') {
      throw new BadRequestException('URL 不能为空');
    }

    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      throw new BadRequestException(`URL 格式无效: ${urlString}`);
    }

    // 1. 协议检查：只允许 http / https
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new BadRequestException(
        `不支持的协议: ${protocol}。仅允许 http 和 https`,
      );
    }

    // 2. Host 检查
    const host = parsed.hostname.toLowerCase();

    // 禁止 localhost
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      throw new BadRequestException('禁止访问 localhost');
    }

    // 禁止 0.0.0.0
    if (host === '0.0.0.0') {
      throw new BadRequestException('禁止访问 0.0.0.0');
    }

    // 禁止内网 IP 段
    if (this.isPrivateIp(host)) {
      throw new BadRequestException(`禁止访问内网地址: ${host}`);
    }

    // 禁止 link-local 地址
    if (this.isLinkLocal(host)) {
      throw new BadRequestException(`禁止访问链路本地地址: ${host}`);
    }

    // 禁止保留 IP
    if (this.isReservedIp(host)) {
      throw new BadRequestException(`禁止访问保留地址: ${host}`);
    }
  }

  /**
   * 判断是否为私有 IP
   */
  private isPrivateIp(ip: string): boolean {
    // IPv4: 10.0.0.0/8
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    // IPv4: 172.16.0.0/12 (172.16-31.x.x)
    const m172 = ip.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (m172) {
      const second = parseInt(m172[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    // IPv4: 192.168.0.0/16
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    // IPv6: fc00::/7 (ULA)
    if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return true;

    return false;
  }

  /**
   * 判断是否为链路本地地址
   */
  private isLinkLocal(ip: string): boolean {
    // IPv4: 169.254.0.0/16
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    // IPv6: fe80::/10
    if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
    return false;
  }

  /**
   * 判断是否为保留地址
   */
  private isReservedIp(ip: string): boolean {
    // IPv4: 127.0.0.0/8 (loopback, 上面已单独处理)
    // IPv4: 224.0.0.0/4 (multicast)
    if (/^22[4-9]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    if (/^23[0-9]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    if (/^24[0-9]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    if (/^25[0-5]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    // IPv4: 100.64.0.0/10 (carrier-grade NAT)
    const m100 = ip.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (m100) {
      const second = parseInt(m100[1], 10);
      if (second >= 64 && second <= 127) return true;
    }
    return false;
  }
}
