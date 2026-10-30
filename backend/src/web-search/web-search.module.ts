import { Module } from '@nestjs/common';
import { WebSearchService } from './web-search.service';

/**
 * 联网搜索模块。
 *
 * 只依赖环境变量（不碰数据库），因此可以被任何模块安全导入，不会形成循环依赖。
 * 目前由 AgentModule 使用；工作流若要接，直接 import 本模块即可。
 */
@Module({
  providers: [WebSearchService],
  exports: [WebSearchService],
})
export class WebSearchModule {}
