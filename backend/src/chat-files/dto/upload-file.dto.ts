import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 上传聊天附件的请求体（multipart/form-data）。
 * 文件本身通过字段 `file` 传入，sessionId 为可选文本字段。
 */
export class UploadFileDto {
  @IsOptional()
  @IsString()
  sessionId?: string;
}

/** 上传策略（供前端做前置校验） */
export class AttachFileDto {
  @IsOptional()
  @IsString({ each: true })
  attachmentIds?: string[];
}
