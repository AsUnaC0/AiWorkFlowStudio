# 02 - Auth 认证模块

> 阅读本文后，你应该能回答：注册/登录的完整流程是什么？JWT 是怎么生成和校验的？为什么 JwtStrategy 里还要查数据库？

---

## 一、整体架构

```
AuthController
    │  /auth/register, /auth/login, /auth/me
    ▼
AuthService
    │  使用 PrismaService 操作 User 表
    │  使用 bcrypt 处理密码
    │  使用 JwtService 签发 Token
    ▼
JwtStrategy + JwtAuthGuard
    │  受保护的接口：@UseGuards(JwtAuthGuard)
    ▼
JwtPayload → validate() → JwtUser（注入到 Controller 的 @CurrentUser()）
```

---

## 二、注册流程

**入口**：`POST /api/auth/register`  
**入参**（RegisterDto）：
```json
{
  "username": "string",
  "email": "string",
  "password": "string"
}
```

**中间处理**（auth.service.ts → register）：

1. **查重邮箱**：`SELECT * FROM User WHERE email = ?` → 存在则抛 `ConflictException('该邮箱已被注册')`
2. **查重用户名**：`SELECT * FROM User WHERE username = ?` → 存在则抛 `ConflictException('该用户名已被占用')`
3. **哈希密码**：`bcrypt.hash(password, 10)` → 得到 `passwordHash`（10 是 salt 轮数）
4. **创建用户**：`INSERT INTO User (username, email, passwordHash) VALUES (...)`
5. **签发 JWT**：调用私有方法 `buildAuthResult(user)`

**出参**（AuthResult）：
```json
{
  "user": {
    "id": "uuid",
    "username": "xxx",
    "email": "xxx",
    "avatar": null,
    "createdAt": "..."
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

> 注意：`passwordHash` 永远不会出现在出参里，`toPublicUser()` 专门做了 Omitting。

---

## 三、登录流程

**入口**：`POST /api/auth/login`  
**入参**（LoginDto）：
```json
{
  "email": "string",
  "password": "string"
}
```

**中间处理**（auth.service.ts → login）：

1. **按邮箱查用户**：`SELECT * FROM User WHERE email = ?` → 不存在则抛 `UnauthorizedException('邮箱或密码不正确')`
2. **比对密码**：`bcrypt.compare(明文密码, passwordHash)` → 返回 false 则抛同样的错误
3. **签发 JWT**：同上

**一个安全细节**：登录失败时，不管是"邮箱不存在"还是"密码错误"，都返回**同样的错误消息**。这样可以防止黑客枚举哪些邮箱已被注册。

> 这层保护做了**两遍**：第一遍在 `AuthService.login()`（两个分支都抛 `'邮箱或密码不正确'`），第二遍在 `AllExceptionsFilter`（**登录接口** 401 响应的 message 会被强制改写，见 [01](./01-项目架构与入口.md)）。即使将来某个新接口漏写了统一文案，过滤器也会兜住。
>
> 注意：过滤器只对 `POST /api/auth/login` 做这层脱敏，其他接口的 401（token 过期/缺失）统一返回「登录已过期，请重新登录」——早期版本对所有 401 一刀切，导致前端把「登录过期」显示成「邮箱或密码不正确」，已修正。

---

## 四、JWT 签发

**buildAuthResult 私有方法**（auth.service.ts → L81-92）：

```typescript
private async buildAuthResult(user: User): Promise<AuthResult> {
  const payload: JwtPayload = {
    sub: user.id,        // 主题（标准字段）
    email: user.email,
    username: user.username,
  };

  return {
    user: this.toPublicUser(user),
    accessToken: await this.jwtService.signAsync(payload),
  };
}
```

JWT Payload 结构（jwt.strategy.ts → L6-10）：
```typescript
interface JwtPayload {
  sub: string;       // 用户 ID（数据库主键）
  email: string;
  username: string;
}
```

> **为什么只放这三个字段？** JWT Payload 里不应该放敏感信息（如密码）。放够标识用户身份的就够了——真正需要其他用户信息时再用 `sub` 去数据库查。

---

## 五、JWT 校验（JwtStrategy）

**文件路径**：`backend/src/auth/strategies/jwt.strategy.ts`

这是 Passport.js 的 JWT 策略，每次请求时自动执行 `validate` 方法：

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),  // 从 Authorization: Bearer xxx 提取 token
      ignoreExpiration: false,                                    // 过期的 token 直接拒绝
      secretOrKey: process.env.JWT_SECRET,                        // 密钥（必须和签发时一致）
    });
  }

  async validate(payload: JwtPayload): Promise<JwtUser> {
    // 关键：用 payload.sub 查数据库，确保用户真实存在
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, username: true },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在，请重新登录');
    }
    return { id: user.id, email: user.email, username: user.username };
  }
}
```

**为什么 validate 里还要查数据库？**
- JWT 签名验证只保证"token 没被篡改"和"没过期"
- 但如果用户被删除了（数据库 reset），旧 token 的签名还是对的
- 这种情况下，后续业务代码用 `payload.sub` 去做外键引用会报 `foreign key constraint violation`
- 所以这里多一次 DB 查询，提前拦住"token 对应的用户不存在"的情况

---

## 六、JwtAuthGuard — 守卫保护

**文件路径**：`backend/src/auth/guards/jwt-auth.guard.ts`

只有一行：
```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

这是 Passport 的通用守卫，传 `'jwt'` 就表示用我们上面注册的 JwtStrategy。

**使用方式**（Controller 里）：
```typescript
@Get('me')
@UseGuards(JwtAuthGuard)               // ← 加了这个，请求必须带合法 token
me(@CurrentUser() user: JwtUser) {      // @CurrentUser() 把 validate() 返回值注入进来
  return this.authService.getMe(user);
}
```

**请求头格式**：
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**不需要鉴权的路由**（public）：AuthController 里的 `register` 和 `login` 没有加 `@UseGuards`，任何人都能调。
