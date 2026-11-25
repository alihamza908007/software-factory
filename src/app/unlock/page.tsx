"use client";

import { useState } from "react";
import { ArrowRight, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function UnlockPage() {
  const [token, setToken] = useState("");

  function unlock(event: React.FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    // The middleware exchanges this one-time query token for an HttpOnly cookie.
    window.location.assign(`/?token=${encodeURIComponent(value)}`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="panel w-full max-w-sm p-6">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <KeyRound className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">Factory locked</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          This instance requires <span className="font-mono">FACTORY_AUTH_TOKEN</span>. Enter the
          token once; it is exchanged for an HttpOnly session cookie and never kept in the URL.
        </p>
        <form onSubmit={unlock} className="mt-5 grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="factory-token">Access token</Label>
            <Input
              id="factory-token"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste the token"
              className="font-mono"
            />
          </div>
          <Button type="submit" disabled={!token.trim()}>
            Unlock
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Scripts can skip this page and send{" "}
          <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>.
        </p>
      </div>
    </main>
  );
}
