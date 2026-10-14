import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { CallToolDto } from './dto/call-tool.dto';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpService } from './mcp.service';

/**
 * MCP Server 管理接口。
 *
 * 独立资源，owner 权限模型，不绑定 Workspace。
 * 通信协议细节全部下沉到 transports / McpConnectionService / McpToolService，
 * Controller 只做参数接收与编排调用。
 */
@Controller('mcp-servers')
@UseGuards(JwtAuthGuard)
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  /** 创建 MCP Server */
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateMcpServerDto) {
    return this.mcpService.create(user.id, dto);
  }

  /** 获取当前用户的全部 MCP Servers */
  @Get()
  findAll(@CurrentUser() user: JwtUser) {
    return this.mcpService.findAll(user.id);
  }

  /** 获取单个 MCP Server */
  @Get(':id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mcpService.findOne(user.id, id);
  }

  /** 更新 MCP Server */
  @Put(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    return this.mcpService.update(user.id, id, dto);
  }

  /** 删除 MCP Server */
  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.mcpService.remove(user.id, id);
  }

  /**
   * 测试连接：initialize 握手 + tools/list，成功后缓存工具与连接状态。
   * 失败时返回 status=ERROR + message（不抛异常，便于前端展示错误详情）。
   */
  @Post(':id/test')
  testConnection(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mcpService.testConnection(user.id, id);
  }

  /** 刷新工具列表（重新握手并覆盖缓存） */
  @Post(':id/tools/refresh')
  refreshTools(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mcpService.refreshTools(user.id, id);
  }

  /** 实时发现工具列表（不落库） */
  @Get(':id/tools')
  listTools(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mcpService.listToolsLive(user.id, id);
  }

  /** 调试用：直接调用某个工具并返回结果 */
  @Post(':id/tools/call')
  callTool(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CallToolDto,
  ) {
    return this.mcpService.callToolForUser(
      user.id,
      id,
      dto.toolName,
      dto.arguments ?? {},
    );
  }
}
