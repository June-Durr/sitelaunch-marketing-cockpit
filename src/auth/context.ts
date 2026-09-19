import { createContext, useContext } from 'react';

/** The signed in person, reduced to what the interface actually needs. */
export interface AuthUser {
  id: string;
  email: string | null;
}

export type AuthPhase =
  /** Supabase is not configured, so there is nobody to sign in. Local mode. */
  | 'local'
  /** Working out whether there is an existing session. */
  | 'checking'
  /** Configured, and nobody is signed in. */
  | 'signed_out'
  /** Configured and signed in. */
  | 'signed_in';

export interface AuthContextValue {
  phase: AuthPhase;
  user: AuthUser | null;
  /** A problem worth showing, such as a link that had already expired. */
  error: string | null;
  /** Send a magic link. Resolves once the request has been accepted. */
  sendMagicLink: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export const AuthContext = createContext<AuthContextValue>({
  phase: 'local',
  user: null,
  error: null,
  sendMagicLink: async () => {
    throw new Error('AuthProvider missing');
  },
  signOut: async () => {},
  clearError: () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
