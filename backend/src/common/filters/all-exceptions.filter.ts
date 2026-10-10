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
          : (obj.message as string) ?? exception.message;
      } else {
        error = exception.name.replace('Exception', '');
        message = res as string;
      }
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      error = 'Internal Server Error';
      // 不向客户端泄露内部错误细节（如 Prisma 报错码/SQL/堆栈摘要等）
      message = '服务器内部错误，请稍后重试或联系管理员';

      // 完整堆栈仅记录在服务端日志，便于排障
      this.logger.error(
        `[${request.method}] ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    // 敏感错误信息保护：401 时不泄露"邮箱不存在" vs "密码错误"
    if (statusCode === HttpStatus.UNAUTHORIZED) {
      message = '邮箱或密码不正确';
    }

    response.status(statusCode).json({
      statusCode,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
