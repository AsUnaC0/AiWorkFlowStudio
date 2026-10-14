import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * 全局异常过滤器 —— 统一错误响应格式。
 *
 * 输出格式：
 *   {
 *     statusCode: 400,
 *     error: "Bad Request",
 *     message: "邮箱已被注册",
 *     path: "/api/auth/register",
 *     timestamp: "2026-10-09T..."
 *   }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode: number;
    let error: string;
    let message: string;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();

      // ValidationPipe 的错误是对象：{ message: [...], error: "Bad Request" }
      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        error = (obj.error as string) ?? exception.message;
        message = Array.isArray(obj.message)
          ? (obj.message as string[]).join('；')
          : ((obj.message as string) ?? exception.message);
      } else {
        error = exception.name.replace('Exception', '');
        message = res;
      }
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      error = 'Internal Server Error';
      // 不向客户端泄露内部错误细节（如 Prisma 报错码/SQL/堆栈摘要等）
      message = '服务器内部错误，请稍后重试或联系管理员';

      // 对「基础设施类」错误给出可操作的原因，避免排障时只看到一个 500
      const hint = this.describeInfraError(exception);

      // 完整堆栈仅记录在服务端日志，便于排障
      this.logger.error(
        `[${request.method}] ${request.url}${hint ? ` —— ${hint}` : ''}`,
        exception instanceof Error ? exception.stack : String(exception),
      );

      // 非生产环境把原因一并返回，开发时能直接看到「迁移没应用」这类问题
      if (hint && process.env.NODE_ENV !== 'production') {
        message = hint;
      }
    }

    // 敏感错误信息保护：登录接口 401 时不泄露"邮箱不存在" vs "密码错误"。
    // 其余接口（token 过期/缺失）原本会一起被改写，导致前端把「登录过期」显示成
    // 「邮箱或密码不正确」，误导性很强，因此只对登录接口脱敏。
    if (statusCode === HttpStatus.UNAUTHORIZED) {
      const isLoginEndpoint = request.path?.includes('/auth/login');
      message = isLoginEndpoint ? '邮箱或密码不正确' : '登录已过期，请重新登录';
    }

    response.status(statusCode).json({
      statusCode,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 把常见的「基础设施类」异常翻译成一句可操作的中文提示。
   *
   * 典型场景：改了 schema 但忘记跑迁移，Prisma 会抛 P2022（列不存在），
   * 原来只会返回一个笼统的 500，排障时很难一眼看出问题。
   */
  private describeInfraError(exception: unknown): string | null {
    if (!exception || typeof exception !== 'object') return null;

    const code = (exception as { code?: unknown }).code;
    if (typeof code !== 'string') return null;

    // Prisma 已知错误码（Pxxxx）
    if (/^P\d{4}$/.test(code)) {
      // P2021 表不存在 / P2022 列不存在
      if (code === 'P2021' || code === 'P2022') {
        return (
          '数据库结构与代码不一致（可能是新的迁移还没有应用）。' +
          '请在 backend 目录执行 `npx prisma migrate deploy` 后重试。'
        );
      }
      // P1001 无法连接 / P1002 连接超时 / P1017 连接被关闭
      if (code === 'P1001' || code === 'P1002' || code === 'P1017') {
        return '无法连接数据库，请检查数据库是否已启动、DATABASE_URL 是否正确。';
      }
      // P2002 唯一约束冲突
      if (code === 'P2002') {
        return '数据已存在（唯一约束冲突）。';
      }
      // P2003 外键约束失败
      if (code === 'P2003') {
        return '关联数据不存在或仍被引用（外键约束失败）。';
      }
    }

    // 少数驱动直接返回原始错误信息
    if (
      exception instanceof Error &&
      /column .* does not exist|relation .* does not exist/i.test(
        exception.message,
      )
    ) {
      return (
        '数据库结构与代码不一致（可能是新的迁移还没有应用）。' +
        '请在 backend 目录执行 `npx prisma migrate deploy` 后重试。'
      );
    }

    return null;
  }
}
