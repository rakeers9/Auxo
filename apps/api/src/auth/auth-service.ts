import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthenticatedUser {
  id: string;
}

export interface AuthService {
  authenticate(accessToken: string): Promise<AuthenticatedUser | null>;
}

export class SupabaseAuthService implements AuthService {
  public constructor(private readonly client: SupabaseClient) {}

  public async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);

    if (error || !data.user) {
      return null;
    }

    return { id: data.user.id };
  }
}
