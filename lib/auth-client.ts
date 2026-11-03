import { createAuthClient } from "better-auth/react";

// Used only for *actions* (sign in, sign up, sign out).
export const authClient = createAuthClient();
