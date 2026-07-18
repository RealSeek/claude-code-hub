"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Key,
  Link2,
  Trash2,
  User,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProviderEndpointsSection } from "@/app/[locale]/settings/providers/_components/provider-endpoints-table";
import { InlineWarning } from "@/components/ui/inline-warning";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { detectApiKeyWarnings } from "@/lib/utils/validation/api-key-warnings";
import type {
  ProviderType,
  ProviderUpstreamBilling,
  ProviderUpstreamBillingType,
} from "@/types/provider";
import { UrlPreview } from "../../url-preview";
import { ProviderKeyPoolEditor } from "../components/provider-key-pool-editor";
import { QuickPasteDialog } from "../components/quick-paste-dialog";
import { SectionCard, SmartInputWrapper } from "../components/section-card";
import { useProviderForm } from "../provider-form-context";

const MAX_DISPLAYED_PROVIDERS = 5;

interface BasicInfoSectionProps {
  autoUrlPending?: boolean;
  upstreamBilling?: ProviderUpstreamBilling;
  endpointPool?: {
    vendorId: number;
    providerType: ProviderType;
    hideLegacyUrlInput: boolean;
  } | null;
}

export function BasicInfoSection({
  autoUrlPending,
  upstreamBilling,
  endpointPool,
}: BasicInfoSectionProps) {
  const t = useTranslations("settings.providers.form");
  const tBatch = useTranslations("settings.providers.batchEdit");
  const tProviders = useTranslations("settings.providers");
  const { state, dispatch, mode, provider, hideUrl, hideWebsiteUrl, batchProviders } =
    useProviderForm();
  const isEdit = mode === "edit";
  const isBatch = mode === "batch";
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [showKey, setShowKey] = useState(false);
  const [showBillingCookie, setShowBillingCookie] = useState(false);
  const [showBillingAccessToken, setShowBillingAccessToken] = useState(false);
  const [showBillingRefreshToken, setShowBillingRefreshToken] = useState(false);

  const apiKeyWarnings = useMemo(() => detectApiKeyWarnings(state.basic.key), [state.basic.key]);
  const upstreamCredentialWarning =
    upstreamBilling?.errorCode === "new_api_cookie_invalid"
      ? t("sections.basic.newApiAccount.cookie.invalidWarning")
      : upstreamBilling?.errorCode === "new_api_access_token_invalid"
        ? t("sections.basic.newApiAccount.accessTokenInvalidWarning")
        : null;

  // Auto-focus name input (skip in batch mode)
  useEffect(() => {
    if (isBatch) return;
    const timer = setTimeout(() => {
      nameInputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [isBatch]);

  // Batch mode: only isEnabled tri-state + provider summary
  if (isBatch) {
    const providers = batchProviders ?? [];
    const displayed = providers.slice(0, MAX_DISPLAYED_PROVIDERS);
    const remaining = providers.length - displayed.length;

    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.2 }}
        className="space-y-6"
      >
        <SectionCard
          title={t("sections.basic.identity.title")}
          description={tBatch("dialog.editDesc", { count: providers.length })}
          icon={User}
          variant="highlight"
        >
          <div className="space-y-4">
            <SmartInputWrapper label={tBatch("fields.isEnabled.label")}>
              <Select
                value={state.batch.isEnabled}
                onValueChange={(v) =>
                  dispatch({
                    type: "SET_BATCH_IS_ENABLED",
                    payload: v as "no_change" | "true" | "false",
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no_change">{tBatch("fields.isEnabled.noChange")}</SelectItem>
                  <SelectItem value="true">{tBatch("fields.isEnabled.enable")}</SelectItem>
                  <SelectItem value="false">{tBatch("fields.isEnabled.disable")}</SelectItem>
                </SelectContent>
              </Select>
            </SmartInputWrapper>

            {providers.length > 0 && (
              <div
                className="rounded-md border bg-muted/50 p-3 text-sm"
                data-testid="affected-summary"
              >
                <p className="font-medium">
                  {tBatch("affectedProviders.title")} ({providers.length})
                </p>
                <div className="mt-1 space-y-0.5 text-muted-foreground">
                  {displayed.map((p) => (
                    <p key={p.id}>
                      {p.name} ({p.maskedKey})
                    </p>
                  ))}
                  {remaining > 0 && (
                    <p className="text-xs">
                      {tBatch("affectedProviders.more", { count: remaining })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {/* Provider Identity */}
      <SectionCard
        title={t("sections.basic.identity.title")}
        description={t("sections.basic.identity.desc")}
        icon={User}
        variant="highlight"
        badge={!isEdit && <QuickPasteDialog disabled={state.ui.isPending} />}
      >
        <div className="space-y-4">
          <SmartInputWrapper label={t("name.label")} required>
            <div className="relative">
              <Input
                ref={nameInputRef}
                id={isEdit ? "edit-name" : "name"}
                value={state.basic.name}
                onChange={(e) => dispatch({ type: "SET_NAME", payload: e.target.value })}
                placeholder={t("name.placeholder")}
                disabled={state.ui.isPending}
                className="pr-10"
                autoComplete="off"
              />
              <User className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            </div>
          </SmartInputWrapper>
        </div>
      </SectionCard>

      {/* Website URL */}
      {!hideWebsiteUrl && (
        <SectionCard
          title={t("websiteUrl.label")}
          description={t("websiteUrl.desc")}
          icon={ExternalLink}
        >
          <SmartInputWrapper label={t("websiteUrl.label")}>
            <div className="relative">
              <Input
                id={isEdit ? "edit-website-url" : "website-url"}
                type="url"
                value={state.basic.websiteUrl}
                onChange={(e) => dispatch({ type: "SET_WEBSITE_URL", payload: e.target.value })}
                placeholder={t("websiteUrl.placeholder")}
                disabled={state.ui.isPending}
                className="pr-10"
                autoComplete="off"
              />
              <ExternalLink className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            </div>
          </SmartInputWrapper>
        </SectionCard>
      )}

      {/* Endpoint Pool */}
      {!hideUrl && endpointPool?.vendorId ? (
        <SectionCard
          title={t("sections.basic.endpointPool.title")}
          description={t("sections.basic.endpointPool.desc")}
          icon={Globe}
        >
          <div className="-mx-5 -mb-5">
            <ProviderEndpointsSection
              vendorId={endpointPool.vendorId}
              providerType={endpointPool.providerType}
              hideTypeColumn={true}
              queryKeySuffix="provider-form"
            />
          </div>
        </SectionCard>
      ) : null}

      {/* API Endpoint */}
      {!hideUrl && !endpointPool?.hideLegacyUrlInput ? (
        <SectionCard
          title={t("sections.basic.endpoint.title")}
          description={t("sections.basic.endpoint.desc")}
          icon={Link2}
        >
          <div className="space-y-4">
            <SmartInputWrapper
              label={t("url.label")}
              description={t("url.description")}
              tooltip={t("url.tooltip")}
              required
            >
              <div className="relative">
                <Input
                  id={isEdit ? "edit-url" : "url"}
                  value={state.basic.url}
                  onChange={(e) => dispatch({ type: "SET_URL", payload: e.target.value })}
                  placeholder={t("url.placeholder")}
                  disabled={state.ui.isPending}
                  className="pr-10 font-mono text-sm"
                  autoComplete="off"
                />
                <Globe className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              </div>
            </SmartInputWrapper>

            {/* URL Preview */}
            {state.basic.url.trim() && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
              >
                <UrlPreview baseUrl={state.basic.url} providerType={state.routing.providerType} />
              </motion.div>
            )}
          </div>
        </SectionCard>
      ) : hideUrl ? (
        <>
          {/* No endpoints warning */}
          {!isEdit && !autoUrlPending && !state.basic.url.trim() && (
            <SectionCard variant="warning">
              <div className="text-sm font-medium">{tProviders("noEndpoints")}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {tProviders("noEndpointsDesc")}
              </div>
            </SectionCard>
          )}
          {/* Loading state */}
          {!isEdit && autoUrlPending && (
            <div className="text-xs text-muted-foreground animate-pulse">
              {tProviders("keyLoading")}
            </div>
          )}
        </>
      ) : null}

      {/* Authentication */}
      <SectionCard
        title={t("sections.basic.auth.title")}
        description={t("sections.basic.auth.desc")}
        icon={Key}
      >
        <div className="space-y-4">
          {isEdit &&
            state.basic.upstreamBillingType !== "official" &&
            upstreamCredentialWarning && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{upstreamCredentialWarning}</span>
              </div>
            )}

          <SmartInputWrapper
            label={t("sections.basic.upstreamBillingType.label")}
            description={t("sections.basic.upstreamBillingType.desc")}
          >
            <Select
              value={state.basic.upstreamBillingType}
              onValueChange={(value) =>
                dispatch({
                  type: "SET_UPSTREAM_BILLING_TYPE",
                  payload: value as ProviderUpstreamBillingType,
                })
              }
              disabled={state.ui.isPending}
            >
              <SelectTrigger id={isEdit ? "edit-upstream-billing-type" : "upstream-billing-type"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {t("sections.basic.upstreamBillingType.options.auto")}
                </SelectItem>
                <SelectItem value="sub2api">
                  {t("sections.basic.upstreamBillingType.options.sub2api")}
                </SelectItem>
                <SelectItem value="new-api">
                  {t("sections.basic.upstreamBillingType.options.newApi")}
                </SelectItem>
                <SelectItem value="official">
                  {t("sections.basic.upstreamBillingType.options.official")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SmartInputWrapper>

          {state.basic.upstreamBillingType !== "official" && (
            <SmartInputWrapper
              label={t("sections.basic.upstreamBillingRefreshInterval.label")}
              description={t("sections.basic.upstreamBillingRefreshInterval.desc")}
            >
              <Input
                id={
                  isEdit
                    ? "edit-upstream-billing-refresh-interval"
                    : "upstream-billing-refresh-interval"
                }
                type="number"
                min={0}
                max={10080}
                step={1}
                value={state.basic.upstreamBillingRefreshIntervalMinutes}
                onChange={(event) =>
                  dispatch({
                    type: "SET_UPSTREAM_BILLING_REFRESH_INTERVAL_MINUTES",
                    payload: Number.parseInt(event.target.value, 10) || 0,
                  })
                }
                placeholder={t("sections.basic.upstreamBillingRefreshInterval.placeholder")}
                disabled={state.ui.isPending}
              />
            </SmartInputWrapper>
          )}

          {state.basic.upstreamBillingType === "new-api" && (
            <div className="grid gap-4 md:grid-cols-2">
              <SmartInputWrapper
                label={t("sections.basic.newApiAccount.userId.label")}
                description={t("sections.basic.newApiAccount.userId.desc")}
                required
              >
                <Input
                  id={isEdit ? "edit-upstream-billing-user-id" : "upstream-billing-user-id"}
                  value={state.basic.upstreamBillingUserId}
                  onChange={(event) =>
                    dispatch({
                      type: "SET_UPSTREAM_BILLING_USER_ID",
                      payload: event.target.value,
                    })
                  }
                  placeholder={t("sections.basic.newApiAccount.userId.placeholder")}
                  disabled={state.ui.isPending}
                  autoComplete="off"
                />
              </SmartInputWrapper>

              <SmartInputWrapper
                label={t("sections.basic.newApiAccount.cookie.label")}
                description={
                  isEdit &&
                  (provider?.hasUpstreamBillingCookie || provider?.hasUpstreamBillingAccessToken)
                    ? t("sections.basic.newApiAccount.cookie.configured")
                    : t("sections.basic.newApiAccount.cookie.desc")
                }
                required={
                  !isEdit ||
                  (!provider?.hasUpstreamBillingCookie && !provider?.hasUpstreamBillingAccessToken)
                }
              >
                <div className="relative">
                  <Input
                    id={isEdit ? "edit-upstream-billing-cookie" : "upstream-billing-cookie"}
                    type={showBillingCookie ? "text" : "password"}
                    value={state.basic.upstreamBillingCookie}
                    onChange={(event) =>
                      dispatch({
                        type: "SET_UPSTREAM_BILLING_COOKIE",
                        payload: event.target.value,
                      })
                    }
                    placeholder={
                      isEdit &&
                      (provider?.hasUpstreamBillingCookie ||
                        provider?.hasUpstreamBillingAccessToken)
                        ? t("sections.basic.newApiAccount.cookie.leaveEmpty")
                        : t("sections.basic.newApiAccount.cookie.placeholder")
                    }
                    disabled={state.ui.isPending}
                    className="pr-10 font-mono text-sm"
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowBillingCookie((visible) => !visible)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={
                      showBillingCookie
                        ? t("sections.basic.newApiAccount.cookie.hide")
                        : t("sections.basic.newApiAccount.cookie.show")
                    }
                  >
                    {showBillingCookie ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </SmartInputWrapper>
            </div>
          )}

          {state.basic.upstreamBillingType === "sub2api" && (
            <div className="grid gap-4 md:grid-cols-2">
              <SmartInputWrapper
                label={t("sections.basic.sub2apiAccount.authToken.label")}
                description={
                  state.basic.upstreamBillingAccessToken === null
                    ? t("sections.basic.sub2apiAccount.authToken.cleared")
                    : isEdit && provider?.hasUpstreamBillingAccessToken
                      ? t("sections.basic.sub2apiAccount.authToken.configured")
                      : t("sections.basic.sub2apiAccount.authToken.desc")
                }
              >
                <div className="relative">
                  <Input
                    id={isEdit ? "edit-sub2api-auth-token" : "sub2api-auth-token"}
                    type={showBillingAccessToken ? "text" : "password"}
                    value={state.basic.upstreamBillingAccessToken ?? ""}
                    onChange={(event) =>
                      dispatch({
                        type: "SET_UPSTREAM_BILLING_ACCESS_TOKEN",
                        payload: event.target.value,
                      })
                    }
                    placeholder={
                      isEdit && provider?.hasUpstreamBillingAccessToken
                        ? t("sections.basic.sub2apiAccount.authToken.leaveEmpty")
                        : t("sections.basic.sub2apiAccount.authToken.placeholder")
                    }
                    disabled={state.ui.isPending}
                    className="pr-20 font-mono text-sm"
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  {isEdit &&
                    provider?.hasUpstreamBillingAccessToken &&
                    state.basic.upstreamBillingAccessToken !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          dispatch({ type: "SET_UPSTREAM_BILLING_ACCESS_TOKEN", payload: null })
                        }
                        className="absolute right-10 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-destructive"
                        aria-label={t("sections.basic.sub2apiAccount.authToken.clear")}
                        title={t("sections.basic.sub2apiAccount.authToken.clear")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() => setShowBillingAccessToken((visible) => !visible)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={
                      showBillingAccessToken
                        ? t("sections.basic.sub2apiAccount.authToken.hide")
                        : t("sections.basic.sub2apiAccount.authToken.show")
                    }
                  >
                    {showBillingAccessToken ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </SmartInputWrapper>

              <SmartInputWrapper
                label={t("sections.basic.sub2apiAccount.refreshToken.label")}
                description={
                  state.basic.upstreamBillingRefreshToken === null
                    ? t("sections.basic.sub2apiAccount.refreshToken.cleared")
                    : isEdit && provider?.hasUpstreamBillingRefreshToken
                      ? t("sections.basic.sub2apiAccount.refreshToken.configured")
                      : t("sections.basic.sub2apiAccount.refreshToken.desc")
                }
              >
                <div className="relative">
                  <Input
                    id={isEdit ? "edit-sub2api-refresh-token" : "sub2api-refresh-token"}
                    type={showBillingRefreshToken ? "text" : "password"}
                    value={state.basic.upstreamBillingRefreshToken ?? ""}
                    onChange={(event) =>
                      dispatch({
                        type: "SET_UPSTREAM_BILLING_REFRESH_TOKEN",
                        payload: event.target.value,
                      })
                    }
                    placeholder={
                      isEdit && provider?.hasUpstreamBillingRefreshToken
                        ? t("sections.basic.sub2apiAccount.refreshToken.leaveEmpty")
                        : t("sections.basic.sub2apiAccount.refreshToken.placeholder")
                    }
                    disabled={state.ui.isPending}
                    className="pr-20 font-mono text-sm"
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  {isEdit &&
                    provider?.hasUpstreamBillingRefreshToken &&
                    state.basic.upstreamBillingRefreshToken !== null && (
                      <button
                        type="button"
                        onClick={() =>
                          dispatch({ type: "SET_UPSTREAM_BILLING_REFRESH_TOKEN", payload: null })
                        }
                        className="absolute right-10 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-destructive"
                        aria-label={t("sections.basic.sub2apiAccount.refreshToken.clear")}
                        title={t("sections.basic.sub2apiAccount.refreshToken.clear")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() => setShowBillingRefreshToken((visible) => !visible)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={
                      showBillingRefreshToken
                        ? t("sections.basic.sub2apiAccount.refreshToken.hide")
                        : t("sections.basic.sub2apiAccount.refreshToken.show")
                    }
                  >
                    {showBillingRefreshToken ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </SmartInputWrapper>
            </div>
          )}

          <SmartInputWrapper
            label={isEdit ? t("key.labelEdit") : t("key.label")}
            description={
              isEdit && provider ? t("key.currentKey", { key: provider.maskedKey }) : undefined
            }
            required={!isEdit}
          >
            <div className="relative">
              <Input
                id={isEdit ? "edit-key" : "key"}
                type={showKey ? "text" : "password"}
                value={state.basic.key}
                onChange={(e) => dispatch({ type: "SET_KEY", payload: e.target.value })}
                placeholder={isEdit ? t("key.leaveEmptyDesc") : t("key.placeholder")}
                disabled={state.ui.isPending}
                className="pr-10 font-mono text-sm"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {apiKeyWarnings.length > 0 && (
              <div className="mt-2 space-y-1">
                {apiKeyWarnings.map((warningId) => (
                  <InlineWarning key={warningId}>{t(`key.warnings.${warningId}`)}</InlineWarning>
                ))}
              </div>
            )}
          </SmartInputWrapper>

          {isEdit && provider ? (
            <SmartInputWrapper
              label={t("key.keyPool.label")}
              description={t("key.keyPool.description")}
            >
              <ProviderKeyPoolEditor providerId={provider.id} disabled={state.ui.isPending} />
            </SmartInputWrapper>
          ) : (
            <>
              <SmartInputWrapper
                label={t("key.keyPool.label")}
                description={t("key.keyPool.description")}
              >
                <Textarea
                  value={state.basic.apiKeysText}
                  onChange={(event) =>
                    dispatch({ type: "SET_API_KEYS_TEXT", payload: event.target.value })
                  }
                  placeholder={t("key.keyPool.placeholder")}
                  disabled={state.ui.isPending}
                  rows={4}
                  className="font-mono text-sm"
                  spellCheck={false}
                />
              </SmartInputWrapper>

              <SmartInputWrapper label={t("key.keyPool.strategyLabel")}>
                <Select
                  value={state.basic.keyStrategy}
                  onValueChange={(value) =>
                    dispatch({
                      type: "SET_KEY_STRATEGY",
                      payload: value as "sequential" | "round_robin",
                    })
                  }
                  disabled={state.ui.isPending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="round_robin">{t("key.keyPool.roundRobin")}</SelectItem>
                    <SelectItem value="sequential">{t("key.keyPool.sequential")}</SelectItem>
                  </SelectContent>
                </Select>
              </SmartInputWrapper>
            </>
          )}
        </div>
      </SectionCard>
    </motion.div>
  );
}
