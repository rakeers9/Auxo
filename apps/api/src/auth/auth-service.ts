export interface AuthenticatedUser {
  id: string;
}

export interface AuthService {
  authenticate(accessToken: string): Promise<AuthenticatedUser | null>;
}

interface SupabaseAuthClient {
  auth: {
    getUser(accessToken: string): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
}

export class SupabaseAuthService implements AuthService {
  public constructor(private readonly client: SupabaseAuthClient) {}

  public async authenticate(accessToken: string): Promise<AuthenticatedUser | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);

    if (error || !data.user) {
      return null;
    }

    return { id: data.user.id };
  }
}
