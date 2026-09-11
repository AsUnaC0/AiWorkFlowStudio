import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  User,
} from "@/types/auth";
import { request } from "@/utils/request";

export const register = (data: RegisterRequest): Promise<AuthResponse> => {
  return request.post("/auth/register", data);
};

export const login = (data: LoginRequest): Promise<AuthResponse> => {
  return request.post("/auth/login", data);
};

export const getCurrentUser = (): Promise<User> => {
  return request.get("/auth/me");
};
