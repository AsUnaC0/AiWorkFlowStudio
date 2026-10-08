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
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpService } from './mcp.service';

/**
 * MCP Server CRUD + 连接测试。
 * 独立资源，owner 权限模型，不绑定 Workspace。
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
  remove(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mcpService.remove(user.id, id);
  }

  /** 测试 MCP Server 连接，获取可用 tools */
  @Post(':id/test')
  testConnection(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mcpService.testConnection(user.id, id);
  }
}
