import { request } from "@/utils/request";

// ========== 类型定义 ==========

export interface FriendItem {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  status: string; // ONLINE / OFFLINE / BUSY
  friendshipId: string;
  friendshipStatus: string; // ACCEPTED / PENDING
  isInitiator: boolean;
  createdAt: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  status: string;
  existingFriendship: {
    id: string;
    status: string;
    isInitiator: boolean;
  } | null;
}

export interface FriendListResponse {
  friends: FriendItem[];
  pendingReceived: FriendItem[];
  pendingSent: FriendItem[];
}

export interface WorkspaceMemberItem {
  userId: string;
  username: string;
  email: string;
  avatar: string | null;
  status: string;
  role: "OWNER" | "MEMBER";
  joinedAt: string;
}

// ========== Friendships API ==========

/** 搜索用户 */
export const searchUsers = (q: string): Promise<UserSearchResult[]> => {
  return request.get("/friendships/search", { params: { q } });
};

/** 获取好友列表（ACCEPTED + PENDING 分类） */
export const getFriendships = (): Promise<FriendListResponse> => {
  return request.get("/friendships");
};

/** 发送好友请求 */
export const sendFriendRequest = (friendId: string) => {
  return request.post("/friendships/request", { friendId });
};

/** 接受好友请求 */
export const acceptFriendRequest = (friendshipId: string) => {
  return request.post(`/friendships/${friendshipId}/accept`);
};

/** 拒绝好友请求 */
export const rejectFriendRequest = (friendshipId: string) => {
  return request.post(`/friendships/${friendshipId}/reject`);
};

/** 删除好友 */
export const removeFriend = (friendId: string) => {
  return request.delete(`/friendships/friends/${friendId}`);
};

// ========== Workspace Members API ==========

/** 列出 Workspace 成员 */
export const getWorkspaceMembers = (
  workspaceId: string,
): Promise<WorkspaceMemberItem[]> => {
  return request.get(`/workspaces/${workspaceId}/members`);
};

/** 邀请好友加入 Workspace */
export const inviteWorkspaceMember = (
  workspaceId: string,
  inviteeId: string,
): Promise<WorkspaceMemberItem> => {
  return request.post(`/workspaces/${workspaceId}/members`, { inviteeId });
};

/** 移除 Workspace 成员 */
export const removeWorkspaceMember = (
  workspaceId: string,
  userId: string,
) => {
  return request.delete(`/workspaces/${workspaceId}/members/${userId}`);
};
