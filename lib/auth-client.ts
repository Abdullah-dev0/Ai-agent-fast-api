import { createAuthClient } from "better-auth/react";

// Used only for *actions* (sign in, sign up, sign out).
// Reading the user goes through getUser() / useUser(), not useSession().
export const authClient = createAuthClient();
