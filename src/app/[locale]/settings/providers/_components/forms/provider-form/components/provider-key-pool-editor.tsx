"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, Plus, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getProviderApiKeys, revealProviderApiKeys, updateProviderApiKeys } from "@/lib/api-client/v1/actions/providers";
import type { ProviderKeyStrategy } from "@/types/provider";

type KeyRow = {
  clientId: string;
  id: number | null;
  maskedKey: string;
  key: string;
  label: string;
  isEnabled: boolean;
  sortOrder: number;
  isPersisted: boolean;
};

type ProviderKeyPoolEditorProps = {
  providerId: number;
  disabled?: boolean;
};

let nextRowId = 0;

function createClientId(id: number | null): string {
  return id == null ? `legacy-${nextRowId++}` : `key-${id}`;
}

export function ProviderKeyPoolEditor({ providerId, disabled = false }: ProviderKeyPoolEditorProps) {
  const t = useTranslations("settings.providers.form.key.keyPool");
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [strategy, setStrategy] = useState<ProviderKeyStrategy>("round_robin");
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);
  const revealInFlight = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef(false);
  const providerIdRef = useRef(providerId);

  const query = useQuery({
    queryKey: ["provider-api-keys", providerId],
    queryFn: async () => {
      const result = await getProviderApiKeys(providerId);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    enabled: providerId > 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!query.data) return;
    if (providerIdRef.current !== providerId) {
      providerIdRef.current = providerId;
      dirtyRef.current = false;
    }
    if (dirtyRef.current) return;
    setStrategy(query.data.strategy);
    setRows(
      query.data.keys.map((key) => ({
        clientId: createClientId(key.id),
        id: key.id,
        maskedKey: key.maskedKey,
        key: "",
        label: key.label ?? "",
        isEnabled: key.isEnabled,
        sortOrder: key.sortOrder,
        isPersisted: true,
      }))
    );
    setRevealed(false);
  }, [query.data]);

  const revealAll = async (): Promise<boolean> => {
    if (revealed) return true;
    if (revealInFlight.current) return revealInFlight.current;
    const task = (async () => {
      setRevealing(true);
      try {
        const result = await revealProviderApiKeys(providerId);
        if (!result.ok) {
          toast.error(t("revealFailed"));
          return false;
        }
        setRows((current) =>
          current.map((row, index) => {
            const revealedKey = row.isPersisted
              ? result.data.keys.find((key) => (row.id == null ? key.id == null : key.id === row.id))
              : undefined;
            return revealedKey
              ? {
                  ...row,
                  key: revealedKey.key,
                  label: revealedKey.label ?? row.label,
                  isEnabled: revealedKey.isEnabled,
                  sortOrder: revealedKey.sortOrder,
                }
              : row;
          })
        );
        setRevealed(true);
        return true;
      } catch {
        toast.error(t("revealFailed"));
        return false;
      } finally {
        setRevealing(false);
        revealInFlight.current = null;
      }
    })();
    revealInFlight.current = task;
    return task;
  };

  const updateRow = (clientId: string, update: Partial<KeyRow>) => {
    dirtyRef.current = true;
    setRows((current) => current.map((row) => (row.clientId === clientId ? { ...row, ...update } : row)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const currentRows = rows;
      if (currentRows.some((row) => !row.isPersisted && row.key.trim() === "")) {
        toast.error(t("missingKey"));
        return;
      }
      const result = await updateProviderApiKeys(providerId, {
        key_strategy: strategy,
        api_keys: currentRows.map((row, index) => ({
          ...(row.id != null ? { id: row.id } : {}),
          ...(row.key.trim() ? { key: row.key.trim() } : {}),
          label: row.label.trim() || null,
          is_enabled: row.isEnabled,
          sort_order: Number.isFinite(row.sortOrder) ? row.sortOrder : index,
        })),
      });
      if (!result.ok) {
        toast.error(t("saveFailed"));
        return;
      }
      toast.success(t("saved"));
      dirtyRef.current = false;
      setRows(currentRows);
      setRevealed(false);
      await queryClient.invalidateQueries({ queryKey: ["provider-api-keys", providerId] });
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (query.isLoading) return <div className="text-xs text-muted-foreground">{t("loading")}</div>;
  if (query.isError) return <div className="text-xs text-destructive">{t("loadFailed")}</div>;

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t("configured", { count: rows.length })}</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={revealed ? t("hide") : t("reveal")}
            title={revealed ? t("hide") : t("reveal")}
            disabled={disabled || revealing}
            onClick={() => {
              if (revealed) {
                setRows((current) => current.map((row) => ({ ...row, key: "" })));
                setRevealed(false);
              } else {
                void revealAll();
              }
            }}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || saving}
            onClick={() =>
              setRows((current) => {
                dirtyRef.current = true;
                return [
                  ...current,
                  {
                    clientId: createClientId(null),
                    id: null,
                    maskedKey: "",
                    key: "",
                    label: "",
                    isEnabled: true,
                    sortOrder: current.length,
                    isPersisted: false,
                  },
                ];
              })
            }
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("add")}
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={disabled || saving || revealing}
            onClick={() => void handleSave()}
          >
            <Save className="mr-1 h-4 w-4" />
            {t("save")}
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        {rows.map((row, index) => (
          <div key={row.clientId} className="grid gap-2 rounded-md border bg-background p-2 md:grid-cols-[minmax(0,1fr)_minmax(8rem,0.7fr)_5rem_auto] md:items-center">
            <div className="flex items-center gap-1">
              <Input
                type={revealed ? "text" : "password"}
                value={revealed ? row.key : row.maskedKey}
                readOnly={!revealed && row.isPersisted}
                disabled={disabled || (!revealed && row.isPersisted)}
                aria-label={t("keyValue", { index: index + 1 })}
                onChange={(event) => updateRow(row.clientId, { key: event.target.value })}
                className="font-mono text-xs"
              />
              {revealed && row.key && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("copy")}
                  title={t("copy")}
                  disabled={disabled}
                  onClick={() => void navigator.clipboard?.writeText(row.key)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Input
              value={row.label}
              disabled={disabled}
              aria-label={t("rowLabel")}
              placeholder={t("labelPlaceholder")}
              onChange={(event) => updateRow(row.clientId, { label: event.target.value })}
            />
            <Input
              type="number"
              min={0}
              value={row.sortOrder}
              disabled={disabled}
              aria-label={t("order")}
              onChange={(event) => updateRow(row.clientId, { sortOrder: Number(event.target.value) })}
            />
            <div className="flex items-center justify-between gap-2">
              <Switch
                checked={row.isEnabled}
                disabled={disabled}
                aria-label={t("enabled")}
                onCheckedChange={(checked) => updateRow(row.clientId, { isEnabled: checked })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("delete")}
                title={t("delete")}
                disabled={disabled || saving}
                onClick={() => {
                  dirtyRef.current = true;
                  setRows((current) => current.filter((item) => item.clientId !== row.clientId));
                }}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="text-xs text-muted-foreground">{t("empty")}</div>}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("strategyLabel")}</span>
        <select
          value={strategy}
          disabled={disabled || saving}
          aria-label={t("strategyLabel")}
          onChange={(event) => {
            dirtyRef.current = true;
            setStrategy(event.target.value as ProviderKeyStrategy);
          }}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="round_robin">{t("roundRobin")}</option>
          <option value="sequential">{t("sequential")}</option>
        </select>
      </div>
    </div>
  );
}
