"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ApiDetailNavigation from "@/components/api-detail-navigation";
import ProductIcon from "@/components/product-icon";
import ApiCatalogueCard from "@/components/api-catalogue-card";
import { catalogueLocationUrl, readCatalogueLocation, type CatalogueLocation } from "@/lib/catalog-location";
import { catalogueScrollContainer, catalogueScrollTop, scrollCatalogueTo } from "@/lib/catalog-scroll";
import {
  API_CATEGORIES,
  AUTHENTICATION_TYPES,
  COMMUNICATION_DIRECTIONS,
  HTTP_METHODS,
  type ApiRecord,
  type ApiSubmission,
  type AuditAction,
  type CommunicationDirection,
  type ReviewStatus,
} from "@/lib/types";
import CatalogCategoryFilter from "@/components/catalog-category-filter";
import ApiInformation from "@/components/api-information";
import CountryRegionLabel from "@/components/country-region-label";
import AdminMetadataBulkUpdate from "@/components/admin-metadata-bulk-update";
import { cataloguePage } from "@/lib/catalog-pagination";
import { catalogueFormatOptions, matchesCatalogueFormat } from "@/lib/catalog-format-filter";
import {
  ALL_CATEGORIES,
  ALL_COMMUNICATION_DIRECTIONS,
  CATALOG_COMMUNICATION_SUBCATEGORIES,
  matchesCatalogueCategory,
} from "@/lib/catalog-category-filter";
import {
  ALL_COUNTRY_REGIONS,
  UNSPECIFIED_COUNTRY_REGION,
  countryRegionForRecord,
} from "@/lib/country-region";
import { coverageFilterValues } from "@/lib/coverage";
import { canManageApi, ownsApi, type AppRole } from "@/lib/auth-policy";
import { visibleCatalogueRecords } from "@/lib/catalog-visibility";
import { auditDetailsForDisplay, publicReviewNote } from "@/lib/audit-presentation";
import { formatFormatsForDisplay, formatInputFormatsForDisplay } from "@/lib/format-display";
import {
  defaultCatalogueSort,
  nextAwaitingVerification,
  sortCatalogueRecords,
  verificationProgressMessage,
  type CatalogueSort,
} from "@/lib/catalog-review-queue";

type RepositoryProps = {
  initialRecords: ApiRecord[];
  initialQuery?: string;
  initialCategory?: string;
  initialCommunicationDirection?: string;
  initialCountryRegion?: string;
  initialScope?: "all" | "mine";
  initialStatus?: string;
  initialApiId?: string;
  profileSubmissions?: boolean;
  userId?: string | null;
  role: AppRole | null;
};
type StorageMode = "dataset" | "supabase";
type CatalogueViewMode = "grid" | "list";
type Notice = { message: string; kind: "success" | "error" } | null;
type ModalKind = "edit" | null;
type VerificationDraft = { review_status: ReviewStatus; verification_notes: string; request_changes?: boolean };

const emptyDraft: ApiSubmission = {
  api_name: "",
  official_api_name: "",
  company_name: "",
  official_company_name: "",
  country_region: "",
  description: "",
  api_endpoint: "",
  documentation_url: "",
  category: "Communication",
  category_other: "",
  communication_direction: "Unspecified",
  authentication_method: "OAuth2",
  authentication_other: "",
  authentication_details: "",
  website_confirm: "",
};

const emptyVerification: VerificationDraft = {
  review_status: "Published",
  verification_notes: "",
};

const categoryTone: Record<string, string> = {
  Communication: "tone-teal",
  Transformation: "tone-blue",
  Validation: "tone-amber",
  Other: "tone-purple",
};

const actionLabels: Record<AuditAction, string> = {
  upload: "uploaded",
  edit: "edited",
  verify: "verified",
  status_change: "changed the status of",
  delete: "deleted",
  restore: "restored",
};

function csvEscape(value: unknown) {
  const stringValue = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  const safeValue = /^[\t\r\n ]*[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function statusClass(value: string) {
  return value === "Published" ? "published" : "verified";
}

function statusMeaning(value: string) {
  return value === "Verified"
    ? "Verified: an administrator recorded a manual check against an official source."
    : "Awaiting verification: publicly listed; an administrator has not yet recorded an official-source check.";
}

function reviewStatusLabel(value: string) {
  return value === "Verified" ? "Verified" : "Awaiting verification";
}

function showOriginal(english: string, original: string) {
  return Boolean(original && original.trim().toLocaleLowerCase() !== english.trim().toLocaleLowerCase());
}

function categoryLabel(record: ApiRecord) {
  if (record.category === "Other" && record.category_other) return `Other · ${record.category_other}`;
  if (record.category !== "Communication") return record.category;
  return CATALOG_COMMUNICATION_SUBCATEGORIES.includes(
    record.communication_direction as (typeof CATALOG_COMMUNICATION_SUBCATEGORIES)[number],
  )
    ? `Communication · ${record.communication_direction}`
    : "Communication";
}

function authenticationLabel(record: ApiRecord) {
  return record.authentication_method === "Other" && record.authentication_other
    ? `Other · ${record.authentication_other}`
    : record.authentication_method;
}

function formatDateTime(value: string | null) {
  if (!value) return "Date not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date not recorded"
    : new Intl.DateTimeFormat("en", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      }).format(date);
}




function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpEndpoint(value: string) {
  // Some official on-premise APIs publish endpoint templates such as
  // http://{VSDC-host}:{port}/path. They are valid catalog endpoints even
  // though the browser URL parser cannot resolve the placeholders yet.
  return /^https?:\/\/[^\s<>"`]+$/i.test(value);
}






function editableFingerprint(value: ApiSubmission) {
  return JSON.stringify({
    api_name: value.api_name.trim(),
    official_api_name: value.official_api_name.trim(),
    company_name: value.company_name.trim(),
    official_company_name: value.official_company_name.trim(),
    country_region: value.country_region.trim(),
    description: value.description.trim(),
    api_endpoint: value.api_endpoint.trim(),
    documentation_url: value.documentation_url.trim(),
    category: value.category,
    category_other: value.category_other.trim(),
    communication_direction: value.communication_direction,
    authentication_method: value.authentication_method,
    authentication_other: value.authentication_other.trim(),
    authentication_details: value.authentication_details.trim(),
    http_method: value.http_method ?? "",
    input_formats: value.input_formats ?? [], output_formats: value.output_formats ?? [],
    invoice_standard: value.invoice_standard ?? [], client_types: value.client_types ?? [],
    access_scope: value.access_scope ?? "unknown", network: value.network ?? "",
    website_url: value.website_url ?? "", instructions: value.instructions ?? "",
    business_rules: value.business_rules ?? [],
  });
}

export default function ApiRepository({
  initialRecords,
  initialQuery = "",
  initialCategory = "All categories",
  initialCommunicationDirection = ALL_COMMUNICATION_DIRECTIONS,
  initialCountryRegion = ALL_COUNTRY_REGIONS,
  initialScope = "all",
  initialStatus = "All records",
  initialApiId = "",
  profileSubmissions = false,
  userId = null,
  role,
}: RepositoryProps) {
  const isAdmin = role === "admin";
  const catalogueEndpoint = profileSubmissions ? "/api/apis?scope=mine" : "/api/apis";
  const defaultSort = defaultCatalogueSort(role);
  const searchParams = useSearchParams();
  // The initial props also support server rendering outside the Next router.
  const location = readCatalogueLocation(searchParams ?? new URLSearchParams({
    q: initialQuery, category: initialCategory, direction: initialCommunicationDirection,
    country: initialCountryRegion, scope: initialScope, status: initialStatus, api: initialApiId,
  }), role);
  const { query, category, communicationDirection, countryRegion, inputFormat, outputFormat, company, status, sort, api: selectedId } = location;
  const scope = profileSubmissions ? "mine" : location.scope;
  const detailsOpen = Boolean(selectedId);
  const [records, setRecords] = useState(initialRecords);
  const [viewMode, setViewMode] = useState<CatalogueViewMode>("list");
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const searchSessionRef = useRef(false);
  const wasDetailsOpen = useRef(detailsOpen);
  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [draft, setDraft] = useState<ApiSubmission>(emptyDraft);
  const [editBaseline, setEditBaseline] = useState<ApiSubmission>(emptyDraft);
  const [editingId, setEditingId] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [verificationApiId, setVerificationApiId] = useState("");
  const [verificationDraft, setVerificationDraft] = useState<VerificationDraft>(emptyVerification);
  const [verificationError, setVerificationError] = useState("");
  const [savingVerification, setSavingVerification] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("dataset");
  const [loadingCatalog, setLoadingCatalog] = useState(initialRecords.length === 0);
  const [catalogError, setCatalogError] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const mutationBusyRef = useRef(false);


  function closeModal() {
    if (mutationBusyRef.current) return;
    setActiveModal(null);
    setDraft(emptyDraft);
    setEditBaseline(emptyDraft);
    setEditingId("");
    setFormError("");
  }

  async function refreshRepository() {
    try {
      const response = await fetch(catalogueEndpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Repository request failed");
      const payload = (await response.json()) as { apis?: ApiRecord[]; mode?: StorageMode };
      setStorageMode(payload.mode ?? "dataset");
      setCatalogError("");
      if (!payload.apis) return;
      setRecords(payload.apis);
    } catch {
      // Keep the last successfully loaded catalog visible.
      setCatalogError("The shared database is temporarily unavailable. The last loaded catalog is still shown.");
    }
  }

  useEffect(() => {
    let active = true;
    fetch(catalogueEndpoint, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Repository request failed");
        return response.json() as Promise<{ apis?: ApiRecord[]; mode?: StorageMode }>;
      })
      .then((payload) => {
        if (!active) return;
        setStorageMode(payload.mode ?? "dataset");
        setLoadingCatalog(false);
        setCatalogError("");
        if (!payload.apis) return;
        setRecords(payload.apis);
      })
      .catch(() => {
        if (!active) return;
        setLoadingCatalog(false);
        setCatalogError("The shared database is temporarily unavailable. Please try again shortly.");
      });
    return () => { active = false; };
  }, [catalogueEndpoint]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (event.key === "/" && !isTyping && !activeModal) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [activeModal]);

  useEffect(() => {
    if (!activeModal) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>("[data-modal-autofocus]")?.focus();
    });
    function handleModalKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleModalKeys);
    return () => {
      document.removeEventListener("keydown", handleModalKeys);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal]);

  const catalogueRecords = useMemo(() => visibleCatalogueRecords(records), [records]);
  const scopedRecords = useMemo(() => scope === "mine"
    ? catalogueRecords.filter((record) => ownsApi(userId, record)) : catalogueRecords, [catalogueRecords, scope, userId]);
  const countryRegions = useMemo(() => [...new Set(scopedRecords.flatMap((record) =>
    coverageFilterValues(countryRegionForRecord(record)),
  ))].sort((a, b) => {
    if (a === UNSPECIFIED_COUNTRY_REGION) return 1;
    if (b === UNSPECIFIED_COUNTRY_REGION) return -1;
    return a.localeCompare(b, "en");
  }), [scopedRecords]);
  const companies = useMemo(() => [...new Set(scopedRecords.map((record) => record.company_name).filter(Boolean))].sort(), [scopedRecords]);
  const inputFormats = useMemo(() => catalogueFormatOptions(scopedRecords.map((record) => record.input_formats), "input"), [scopedRecords]);
  const outputFormats = useMemo(() => catalogueFormatOptions(scopedRecords.map((record) => record.output_formats), "output"), [scopedRecords]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = scopedRecords.filter((record) => {
      const matchesQuery = !normalized || [
        record.api_name, record.official_api_name, record.company_name, record.official_company_name,
        record.description, record.api_endpoint, record.category_other, record.communication_direction,
        countryRegionForRecord(record), record.http_method, ...record.client_types, ...record.invoice_standard, record.authentication_method,
        record.authentication_other, record.authentication_details, ...record.input_formats, ...record.output_formats,
      ].join(" ").toLowerCase().includes(normalized);
      return matchesQuery
        && matchesCatalogueCategory(record, category, communicationDirection)
        && matchesCatalogueFormat(record.input_formats, inputFormat)
        && matchesCatalogueFormat(record.output_formats, outputFormat)
        && (countryRegion === ALL_COUNTRY_REGIONS
          || coverageFilterValues(countryRegionForRecord(record)).includes(countryRegion))
        && (company === "All companies" || record.company_name === company)
        && (status === "All records" || record.review_status === status);
    });
    return sortCatalogueRecords(matches, sort);
  }, [scopedRecords, category, communicationDirection, company, countryRegion, inputFormat, outputFormat, query, sort, status]);

  const paginationKey = JSON.stringify([scope, query, category, communicationDirection, company, countryRegion, inputFormat, outputFormat, status, sort]);
  const currentPage = cataloguePage(filtered, location.page);
  const pageRecords = currentPage.items;

  // A stale inbox link must not silently open another API's management actions.
  // A saved API can leave the current filters; keep its detail readable, with no unrelated neighbours.
  const selected = selectedId ? scopedRecords.find((record) => record.id === selectedId) : filtered[0];
  const missingLinkedApi = Boolean(selectedId && !selected);
  const selectedIndex = filtered.findIndex((record) => record.id === selectedId);
  const sessionUser = role ? { id: userId ?? "", role } : null;
  const canManageSelected = Boolean(selected && canManageApi(sessionUser, selected));
  const editingRecord = records.find((record) => record.id === editingId);
  const canEditDraft = Boolean(editingRecord && canManageApi(sessionUser, editingRecord));
  const awaitingVerificationCount = scopedRecords.filter((record) => record.review_status === "Published").length;
  const verifiedCount = scopedRecords.filter((record) => record.review_status === "Verified").length;
  const noSubmissions = scope === "mine" && !catalogError && scopedRecords.length === 0;
  const hasActiveFilters = Boolean(
    query
    || category !== ALL_CATEGORIES
    || communicationDirection !== ALL_COMMUNICATION_DIRECTIONS
    || countryRegion !== ALL_COUNTRY_REGIONS
    || inputFormat !== ""
    || outputFormat !== ""
    || company !== "All companies"
    || status !== "All records"
    || sort !== defaultSort
  );
  const auditTrail = [...(selected?.audit_trail ?? [])].sort((a, b) => new Date(b.action_at).getTime() - new Date(a.action_at).getTime());
  const publicVerificationNote = publicReviewNote(selected?.verification_notes);
  const editHasChanges = editableFingerprint(draft) !== editableFingerprint(editBaseline);

  useEffect(() => {
    const resetSearchSession = () => { searchSessionRef.current = false; };
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    window.addEventListener("popstate", resetSearchSession);
    return () => {
      window.history.scrollRestoration = previousRestoration;
      window.removeEventListener("popstate", resetSearchSession);
    };
  }, []);

  useEffect(() => {
    if (wasDetailsOpen.current && !detailsOpen) {
      const list = document.getElementById("catalogue-results-title");
      if (list) {
        const trigger = detailTriggerRef.current;
        (trigger?.isConnected ? trigger : list).focus({ preventScroll: true });
        catalogueScrollContainer(list).scrollTo({ top: window.history.state?.catalogueScroll ?? 0, behavior: "instant" });
      }
    }
    wasDetailsOpen.current = detailsOpen;
  }, [detailsOpen]);

  useEffect(() => {
    if (verificationOpen && verificationApiId !== selected?.id) {
      setVerificationOpen(false);
      setVerificationApiId("");
      setVerificationError("");
    }
  }, [selected?.id, verificationApiId, verificationOpen]);

  function resetFilters() {
    updateLocation({ ...readCatalogueLocation(new URLSearchParams(), role), api: "" });
  }

  function updateLocation(patch: Partial<CatalogueLocation>, mode: "push" | "replace" = "push") {
    const url = catalogueLocationUrl(window.location.href, patch, role);
    if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    // Next copies its own history metadata. Passing __NA ourselves bypasses its URL synchronization.
    const state = { catalogueScroll: window.history.state?.catalogueScroll ?? 0 };
    if (mode === "push") window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
  }

  function changeFilters(patch: Partial<CatalogueLocation>) {
    searchSessionRef.current = false;
    updateLocation({ ...patch, page: 1, api: "" });
  }

  function changeQuery(query: string) {
    updateLocation({ query, page: 1, api: "" }, searchSessionRef.current ? "replace" : "push");
    searchSessionRef.current = true;
  }

  function openDetailsFromList(id: string) {
    if (!detailsOpen) {
      detailTriggerRef.current = document.activeElement as HTMLElement | null;
      const list = document.getElementById("catalogue-results-title");
      const catalogueScroll = list ? catalogueScrollTop(catalogueScrollContainer(list)) : 0;
      window.history.replaceState({ catalogueScroll }, "", catalogueLocationUrl(window.location.href, {}, role));
    }
    searchSessionRef.current = false;
    updateLocation({ api: id });
    setVerificationOpen(false);
    setVerificationApiId("");
    setVerificationError("");
  }

  function closeDetails() {
    updateLocation({ api: "" });
    setVerificationOpen(false);
  }

  function changePage(page: number) {
    updateLocation({ page });
    window.requestAnimationFrame(() => {
      const heading = document.getElementById("catalogue-results-title");
      heading?.focus({ preventScroll: true });
      if (heading) scrollCatalogueTo(heading);
    });
  }

  function jumpToPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("page") as HTMLInputElement;
    const page = input.valueAsNumber;
    if (Number.isInteger(page) && page >= 1 && page <= currentPage.pages) changePage(page);
    else input.reportValidity();
  }


  function openEdit() {
    if (!canManageSelected || !selected) return;
    setEditingId(selected.id);
    const nextDraft: ApiSubmission = {
      http_method: selected.http_method, input_formats: selected.input_formats, output_formats: selected.output_formats,
      invoice_standard: selected.invoice_standard, client_types: selected.client_types, access_scope: selected.access_scope,
      network: selected.network, website_url: selected.website_url, instructions: selected.instructions, business_rules: selected.business_rules,
      api_name: selected.api_name,
      official_api_name: selected.official_api_name,
      company_name: selected.company_name,
      official_company_name: selected.official_company_name,
      country_region: selected.country_region,
      description: selected.description,
      api_endpoint: selected.api_endpoint,
      documentation_url: selected.documentation_url,
      category: selected.category,
      category_other: selected.category_other,
      communication_direction: selected.communication_direction,
      authentication_method: selected.authentication_method,
      authentication_other: selected.authentication_other,
      authentication_details: selected.authentication_details,
      website_confirm: "",
    };
    setDraft(nextDraft);
    setEditBaseline(nextDraft);
    setFormError("");
    setActiveModal("edit");
  }

  function exportCsv() {
    if (!isAdmin) return;
    const fields: (keyof ApiRecord)[] = [
      "api_name", "official_api_name", "company_name", "official_company_name", "description",
      "country_region", "api_endpoint", "documentation_url", "category", "category_other", "communication_direction", "authentication_method",
      "authentication_other", "authentication_details", "network", "input_formats", "output_formats",
      "business_rules", "client_types", "review_status", "verified_by", "verified_at", "source_url",
    ];
    const csv = [fields.map(csvEscape).join(","), ...filtered.map((record) => fields.map((field) =>
      csvEscape(field === "country_region" ? countryRegionForRecord(record) : record[field])
    ).join(","))].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "business-api-repository-export.csv"; anchor.click(); URL.revokeObjectURL(url);
  }

  async function copyEndpoint() {
    if (!selected?.api_endpoint) return;
    try { await navigator.clipboard.writeText(selected.api_endpoint); setNotice({ message: "Endpoint copied", kind: "success" }); }
    catch { setNotice({ message: "Could not copy the endpoint", kind: "error" }); }
    window.setTimeout(() => setNotice(null), 1_800);
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditDraft || submitting || !editingId) return;
    setSubmitting(true); setFormError("");
    try {
      const response = await fetch("/api/apis", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, ...draft }),
      });
      const payload = (await response.json().catch(() => ({}))) as { api?: ApiRecord; warning?: string; error?: string; requestId?: string };
      if (!response.ok || !payload.api) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "The API could not be updated."}${suffix}`);
      }
      setRecords((current) => current.map((record) => record.id === editingId ? payload.api as ApiRecord : record));
      updateLocation({ api: payload.api.id }, "replace"); setActiveModal(null); setDraft(emptyDraft); setEditingId("");
      setNotice(payload.warning
        ? { message: `API changes saved. ${payload.warning}`, kind: "error" }
        : { message: "API changes saved. The edit was added to its history.", kind: "success" });
      window.setTimeout(() => setNotice(null), 4_200);
      await refreshRepository();
    } catch (error) { setFormError(error instanceof Error ? error.message : "The API could not be updated."); }
    finally { setSubmitting(false); }
  }

  function openVerificationEditor(requestChanges = false) {
    if (!isAdmin || !selected) return;
    setVerificationApiId(selected.id);
    setVerificationDraft({
      review_status: requestChanges ? "Published" : selected.review_status,
      verification_notes: requestChanges ? "" : publicReviewNote(selected.verification_notes) ?? "",
      request_changes: requestChanges,
    });
    setVerificationError(""); setVerificationOpen(true);
  }

  async function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const verificationTarget = records.find((record) => record.id === verificationApiId);
    if (!isAdmin || !verificationTarget || verificationTarget.id !== selected?.id || savingVerification) return;
    setSavingVerification(true); setVerificationError("");
    try {
      const response = await fetch("/api/apis", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: verificationTarget.id,
          review_status: verificationDraft.review_status,
          verification_notes: verificationDraft.verification_notes,
          request_changes: verificationDraft.request_changes === true,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { api?: ApiRecord; warning?: string; error?: string; requestId?: string; awaitingVerificationCount?: number | null };
      if (!response.ok || !payload.api) {
        const suffix = payload.requestId ? ` Reference: ${payload.requestId}` : "";
        throw new Error(`${payload.error ?? "Verification could not be saved."}${suffix}`);
      }
      const saved = payload.api;
      const completedReview = verificationTarget.review_status === "Published" && saved.review_status === "Verified";
      const nextApi = completedReview ? nextAwaitingVerification(filtered, verificationTarget.id) : undefined;
      setRecords((current) => current.map((record) => record.id === verificationTarget.id ? saved : record));
      // Do not hijack navigation if the administrator left this API while the save was in flight.
      if (new URLSearchParams(window.location.search).get("api") === verificationTarget.id) {
        updateLocation({ api: nextApi?.id ?? saved.id }, "replace");
      }
      setVerificationOpen(false); setVerificationApiId("");
      const progressMessage = verificationProgressMessage(payload.awaitingVerificationCount);
      setNotice(payload.warning
        ? { message: `Status saved. ${payload.warning}${progressMessage}`, kind: "error" }
        : { message: saved.review_status === "Verified" ? `Verification saved and added to the audit trail.${progressMessage}` : saved.verification_notes ? "Feedback saved. The API is awaiting verification." : "Verification removed; the API remains publicly listed as awaiting verification.", kind: "success" });
      window.setTimeout(() => setNotice(null), 4_200);
      await refreshRepository();
    } catch (error) { setVerificationError(error instanceof Error ? error.message : "Verification could not be saved."); }
    finally { setSavingVerification(false); }
  }

  return (
    <main className="app-shell catalogue-shell" id="main-content">
      <section className="workspace catalog-workspace" id="catalog">
        {catalogError && <p className="repository-alert" role="alert">{catalogError}</p>}
        <div className="catalogue-page-header" hidden={detailsOpen}>
          <div>
            <p className="eyebrow">API directory</p>
            <h1>{scope === "mine" ? "My submissions" : isAdmin && status === "Published" ? "Awaiting verification" : "All APIs"}</h1>
            {scope !== "mine" && <p className="intro-copy">Find APIs by country, provider and capability. Open a listing to review its integration requirements.</p>}
            <details className="catalogue-status-help"><summary>What does verification mean?</summary><p>All listings can be browsed publicly. Verified means an administrator checked an official source; it does not guarantee provider access or compatibility.</p></details>
          </div>
          <div className="catalogue-page-tools">
            {loadingCatalog && <span className="connection-state">Loading catalogue…</span>}
            {isAdmin && <button className="button secondary" type="button" onClick={exportCsv}>Export current view</button>}
          </div>
        </div>

        {role && <div className="submission-toolbar" hidden={detailsOpen} role="group" aria-label="Repository actions">
          <button className="text-button" type="button" onClick={() => void refreshRepository()}>Refresh status</button>
        </div>}
        {isAdmin && !profileSubmissions && !detailsOpen && <AdminMetadataBulkUpdate onCommitted={() => refreshRepository()} />}
        {scope === "mine" && <p className="submission-help" hidden={detailsOpen}>{role ? "Track your submissions and edit them at any verification status. Verification updates appear in your inbox." : <a href="/login?next=%2Fapis%3Fscope%3Dmine">Log in to view your submissions.</a>}</p>}
        {missingLinkedApi && !loadingCatalog && !catalogError && <p className="submission-help">The linked API is not available in this view. It may be filtered out or removed. <a href={scope === "mine" ? "/profile?view=submissions" : "/apis"}>{scope === "mine" ? "View all my submissions" : "View all APIs"}</a>.</p>}

        <div className={`stat-grid catalogue-stats ${isAdmin || scope === "mine" ? "" : "public-catalogue-stats"}`} aria-label="Repository statistics" hidden={detailsOpen}>
          <article><strong>{loadingCatalog ? "—" : scopedRecords.length}</strong><span>{scope === "mine" ? "My submitted APIs" : "Total APIs"}</span></article>
          {scope !== "mine" && <article><strong>{loadingCatalog ? "—" : companies.length}</strong><span>Companies</span></article>}
          {(isAdmin || scope === "mine") && <article><strong>{loadingCatalog ? "—" : awaitingVerificationCount}</strong><span>Awaiting verification</span></article>}
          {(isAdmin || scope === "mine") && <article><strong>{loadingCatalog ? "—" : verifiedCount}</strong><span>Verified</span></article>}
        </div>

        <div className="filter-panel catalog-filter-panel with-status" hidden={detailsOpen}>
          <label className="search-field"><span className="sr-only">Search APIs</span><span aria-hidden="true">⌕</span><input ref={searchInputRef} value={query} onChange={(event) => changeQuery(event.target.value)} onBlur={() => { searchSessionRef.current = false; }} onKeyDown={(event) => { if (event.key === "Enter") searchSessionRef.current = false; }} placeholder="Search API, country, company, endpoint, format…" /><kbd aria-hidden="true">/</kbd></label>
          <CatalogCategoryFilter
            category={category}
            communicationDirection={communicationDirection}
            onChange={(nextCategory, nextDirection) => {
              changeFilters({ category: nextCategory, communicationDirection: nextDirection });
            }}
          />
          <label><span>Country / region</span><select value={countryRegion} onChange={(event) => changeFilters({ countryRegion: event.target.value })}><option>{ALL_COUNTRY_REGIONS}</option>{countryRegion !== ALL_COUNTRY_REGIONS && !countryRegions.includes(countryRegion) && <option>{countryRegion}</option>}{countryRegions.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Status</span><select value={status} onChange={(event) => changeFilters({ status: event.target.value })}><option>All records</option><option value="Published">Awaiting verification</option><option>Verified</option></select></label>
          <label><span>Company</span><select value={company} onChange={(event) => changeFilters({ company: event.target.value })}><option>All companies</option>{company !== "All companies" && !companies.includes(company) && <option>{company}</option>}{companies.map((item) => <option key={item}>{item}</option>)}</select></label>
          <div className="catalog-secondary-filters">
            <label><span>Input format</span><select value={inputFormat} onChange={(event) => changeFilters({ inputFormat: event.target.value })}><option value="">All input formats</option>{inputFormat && !inputFormats.some((item) => item.value === inputFormat) && <option value={inputFormat}>{inputFormat}</option>}{inputFormats.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>Output format</span><select value={outputFormat} onChange={(event) => changeFilters({ outputFormat: event.target.value })}><option value="">All output formats</option>{outputFormat && !outputFormats.some((item) => item.value === outputFormat) && <option value={outputFormat}>{outputFormat}</option>}{outputFormats.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="catalog-sort-filter"><span>Sort by</span><select value={sort} onChange={(event) => changeFilters({ sort: event.target.value as CatalogueSort })}>{(isAdmin || sort === "awaiting") && <option value="awaiting">Awaiting first</option>}<option value="name">API name</option><option value="company">Company</option>{(isAdmin || sort === "verified") && <option value="verified">Verified first</option>}<option value="updated">Recently updated</option></select></label>
          </div>
        </div>

        <p className="location-filter-note" hidden={detailsOpen}>Country filters include suggested locations from provider names and source URLs. Check each listing for confirmed service coverage.</p>
        <div className={`catalog-layout view-${viewMode} ${detailsOpen ? "detail-open" : ""}`}>
          <section className="catalog-list" aria-label="API results" hidden={detailsOpen && !missingLinkedApi}>
            <div className="section-heading">
              <div><h2 id="catalogue-results-title" tabIndex={-1}>API catalogue</h2><span aria-live="polite">{filtered.length} results</span></div>
              <div className="section-heading-actions">
                <div className="catalog-view-switcher" role="group" aria-label="Catalogue view">
                  <button type="button" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}>Grid</button>
                  <button type="button" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>List</button>
                </div>
                {hasActiveFilters && <button type="button" className="text-button" onClick={resetFilters}>Clear filters</button>}
              </div>
            </div>
            {filtered.length === 0
              ? <div className="empty-state"><strong>{loadingCatalog ? "Loading the shared catalog…" : catalogError ? (scope === "mine" ? "Your submissions could not be loaded." : "The catalogue could not be loaded.") : noSubmissions ? "You have no active API submissions yet." : isAdmin && status === "Published" ? "No APIs await verification in the current filters." : !isAdmin && catalogueRecords.length === 0 ? "No APIs are available in the catalogue yet." : "No APIs match these filters."}</strong>{!loadingCatalog && !catalogError && !noSubmissions && (!isAdmin && catalogueRecords.length === 0 ? <p>Records will appear here when APIs are submitted.</p> : <><p>{isAdmin && status === "Published" ? "Choose another status or adjust the filters to browse other APIs." : "Try a broader search or clear the current filters."}</p>{hasActiveFilters && <button className="button secondary" type="button" onClick={resetFilters}>Clear filters</button>}</>)}</div>
              : viewMode === "grid"
                ? <div className="result-list grid-view">
                    {pageRecords.map((record) => (
                      <div className="api-card-row viewer" key={record.id}>
                        <ApiCatalogueCard record={record} category={categoryLabel(record)} categoryTone={categoryTone[record.category] ?? "tone-gray"} status={reviewStatusLabel(record.review_status)} statusClass={statusClass(record.review_status)} statusMeaning={statusMeaning(record.review_status)} authentication={authenticationLabel(record)} selected={selected?.id === record.id} onOpen={() => openDetailsFromList(record.id)} />
                      </div>
                    ))}
                  </div>
                : <div className="catalog-list-table-shell">
                    <table className="catalog-list-table">
                      <caption className="sr-only">Filtered API catalogue</caption>
                      <thead>
                        <tr>
                          <th className="catalog-list-api-column" scope="col">API</th>

                          <th className="catalog-list-category-column" scope="col">Category</th>
                          <th className="catalog-list-country-column" scope="col">Country / region</th>
                          <th className="catalog-list-formats-column" scope="col">Input → output</th>
                          <th className="catalog-list-status-column" scope="col">Review</th><th className="catalog-list-open-column" scope="col"><span className="sr-only">Details</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRecords.map((record) => (
                          <tr
                            className={selected?.id === record.id ? "selected" : ""}
                            key={record.id}
                            tabIndex={0}
                            aria-label={`View details for ${record.api_name}`}
                            aria-controls="api-detail"
                            aria-current={selected?.id === record.id ? "true" : undefined}
                            onClick={() => openDetailsFromList(record.id)}
                            onKeyDown={(event) => {
                              if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                                event.preventDefault();
                                openDetailsFromList(record.id);
                              }
                            }}
                          >
                            <td className="catalog-list-api-column"><button className="catalog-api-link" type="button" onClick={(event) => { event.stopPropagation(); openDetailsFromList(record.id); }}>{record.api_name}</button><span className="catalog-provider">{record.company_name}</span><span className={`mobile-review status-label ${statusClass(record.review_status)}`}>{reviewStatusLabel(record.review_status)}</span>{showOriginal(record.api_name, record.official_api_name) && <small lang="und">{record.official_api_name}</small>}<span className="catalog-list-description">{record.description}</span><code title={record.api_endpoint}>{record.http_method ? `${record.http_method} ` : ""}{record.api_endpoint || "Endpoint not listed"}</code></td>

                            <td className="catalog-list-category-column"><span className={`pill ${categoryTone[record.category] ?? "tone-gray"}`}>{categoryLabel(record)}</span></td>
                            <td className="catalog-list-country-column"><CountryRegionLabel record={record} /></td>
                            <td className="catalog-list-formats-column"><span className="catalog-format-flow" title={`Input: ${formatInputFormatsForDisplay(record.input_formats)} → Output: ${formatFormatsForDisplay(record.output_formats)}`}><span>{formatInputFormatsForDisplay(record.input_formats)}</span><span aria-hidden="true">→</span><span>{formatFormatsForDisplay(record.output_formats)}</span></span></td>
                            <td className="catalog-list-status-column"><span className={`status-label ${statusClass(record.review_status)}`} title={statusMeaning(record.review_status)}>{reviewStatusLabel(record.review_status)}</span></td><td className="catalog-list-open-column" aria-hidden="true">→</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>}
            {filtered.length > 0 && <nav className="catalog-pagination" aria-label="Catalogue pages">
              <span aria-live="polite">Showing <strong>{currentPage.from}–{currentPage.to}</strong> of {filtered.length} APIs</span>
              <div>
                <button className="button secondary catalog-page-control" type="button" aria-label="First page" title="First page" disabled={currentPage.page === 1} onClick={() => changePage(1)}><ProductIcon name="first-page" /></button>
                <button className="button secondary catalog-page-control" type="button" aria-label="Previous page" title="Previous page" disabled={currentPage.page === 1} onClick={() => changePage(currentPage.page - 1)}><ProductIcon name="arrow-left" /></button>
                <form className="catalog-page-jump" key={`${paginationKey}:${currentPage.page}:${currentPage.pages}`} onSubmit={jumpToPage}>
                  <label htmlFor="catalogue-page-number">Page</label>
                  <input id="catalogue-page-number" aria-label="Page number" name="page" type="number" inputMode="numeric" min={1} max={currentPage.pages} step={1} required defaultValue={currentPage.page} />
                  <span>of {currentPage.pages}</span>
                  <button className="button secondary" type="submit">Go</button>
                </form>
                <button className="button secondary catalog-page-control" type="button" aria-label="Next page" title="Next page" disabled={currentPage.page === currentPage.pages} onClick={() => changePage(currentPage.page + 1)}><ProductIcon name="arrow" /></button>
                <button className="button secondary catalog-page-control" type="button" aria-label="Last page" title="Last page" disabled={currentPage.page === currentPage.pages} onClick={() => changePage(currentPage.pages)}><ProductIcon name="last-page" /></button>
              </div>
            </nav>}
          </section>

          <aside className="detail-panel" id="api-detail" aria-label="Selected API details" hidden={!detailsOpen}>
            {detailsOpen && selected ? <ApiDetailNavigation api={selected} previous={selectedIndex > 0 ? filtered[selectedIndex - 1] : undefined} next={selectedIndex >= 0 ? filtered[selectedIndex + 1] : undefined} onNavigate={openDetailsFromList} onBack={closeDetails} disabled={Boolean(activeModal)} /> : <button className="detail-back" type="button" onClick={closeDetails}>← Back to results</button>}
            {selected ? <>
              <div className="detail-header"><div className="company-avatar" aria-hidden="true">{selected.company_name.slice(0, 2).toUpperCase()}</div><div><span className="detail-company">{selected.company_name}</span>{showOriginal(selected.company_name, selected.official_company_name) && <span className="official-company" lang="und">{selected.official_company_name}</span>}<h1 id="api-detail-heading" tabIndex={-1}>{selected.api_name}</h1>{showOriginal(selected.api_name, selected.official_api_name) && <p className="detail-official-name" lang="und">{selected.official_api_name}</p>}</div></div>
              <div className="detail-badges"><CountryRegionLabel record={selected} /><span className={`pill ${categoryTone[selected.category] ?? "tone-gray"}`}>{categoryLabel(selected)}</span><span className={`pill tone-gray status-${statusClass(selected.review_status)}`} title={statusMeaning(selected.review_status)}>{reviewStatusLabel(selected.review_status)}</span>{selected.network && <span className="pill tone-purple">{selected.network}</span>}</div>
              <ApiInformation key={selected.id} record={selected} onCopyEndpoint={copyEndpoint} />

              <section className={`verification-panel ${selected.review_status === "Verified" ? "verified" : ""}`}>
                <div className="verification-heading"><div><span>Verification status</span><strong>{reviewStatusLabel(selected.review_status)}</strong></div>{isAdmin && <div className="review-action-buttons"><button className="button secondary" type="button" onClick={() => openVerificationEditor()}>Update status</button><button className="text-button" type="button" onClick={() => openVerificationEditor(true)}>Request changes</button></div>}</div>
                {selected.review_status === "Verified" ? <div className="verification-record"><p>Marked verified by <strong>{selected.verified_by || "Internal user"}</strong><span>{formatDateTime(selected.verified_at)}</span></p><p>{publicVerificationNote || "Official source checked; no public note supplied."}</p></div> : <p className="verification-copy">This API is publicly listed and is awaiting an official-source check by an administrator.</p>}
                {selected.review_status === "Published" && publicVerificationNote && <div className="review-feedback"><h3>Administrator feedback</h3><p>{publicVerificationNote}</p>{canManageSelected && !isAdmin && <button className="button secondary" type="button" onClick={openEdit}>Edit and resubmit</button>}</div>}
                {isAdmin && verificationOpen && <form className="verification-form" onSubmit={submitVerification}>
                  <label><span>Review action</span><select value={verificationDraft.request_changes ? "changes" : verificationDraft.review_status} onChange={(event) => setVerificationDraft({ review_status: event.target.value === "Verified" ? "Verified" : "Published", request_changes: event.target.value === "changes", verification_notes: "" })}><option value="Published">Awaiting verification</option><option value="changes">Request changes</option><option>Verified</option></select></label>
                  <label className="full"><span>{verificationDraft.review_status === "Verified" ? "Verification note *" : verificationDraft.request_changes ? "What needs to change? *" : "Feedback to submitter (optional)"}</span><textarea required={verificationDraft.review_status === "Verified" || verificationDraft.request_changes} rows={3} maxLength={1_000} placeholder={verificationDraft.review_status === "Verified" ? "What official source was checked, and what matched?" : "Explain what information is missing or needs correction."} value={verificationDraft.verification_notes} onChange={(event) => setVerificationDraft({ ...verificationDraft, verification_notes: event.target.value })} /><small>This note is shown on the public API record.</small></label>
                  <p className="verification-disclaimer full">This status change will be signed with your administrator account.</p>
                  {verificationError && <p className="form-error full" role="alert">{verificationError}</p>}
                  <div className="verification-actions full"><button className="button secondary" type="button" disabled={savingVerification} onClick={() => { setVerificationOpen(false); setVerificationApiId(""); setVerificationError(""); }}>Cancel</button><button className="button primary" type="submit" disabled={savingVerification}>{savingVerification ? "Saving…" : "Save status"}</button></div>
                </form>}
              </section>

              {canManageSelected && <section className="detail-section audit-section">
                <div className="audit-heading"><h3>{isAdmin ? "Action history" : "Submission progress"}</h3><span>{auditTrail.length} event{auditTrail.length === 1 ? "" : "s"}</span></div>
                {auditTrail.length > 0 ? <ol className="audit-timeline">{auditTrail.map((event) => <li key={event.id}><span className={`audit-marker action-${event.action}`} aria-hidden="true" /><div><p><strong>{event.actor_name || "Internal user"}</strong>{` ${actionLabels[event.action]} this API`}</p><time dateTime={event.action_at}>{formatDateTime(event.action_at)}</time><span className="audit-details">{auditDetailsForDisplay(event)}</span></div></li>)}</ol> : <p className="audit-empty">No action history has been recorded for this dataset entry yet.</p>}
              </section>}
              {canManageSelected && <div className="detail-actions">
                <button className="button secondary" type="button" onClick={openEdit}>Edit API</button>
              </div>}
            </> : <div className="empty-state"><strong>{missingLinkedApi ? loadingCatalog ? "Loading the linked API…" : "The linked API is unavailable in this view. Select another API from the catalogue." : "Select an API to view details."}</strong></div>}
          </aside>
        </div>
      </section>

      {canEditDraft && activeModal === "edit" && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
        <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-api-title" aria-describedby="edit-api-description">
          <div className="modal-heading"><div><p className="eyebrow">Catalog maintenance</p><h2 id="edit-api-title">Edit API</h2></div><button type="button" aria-label="Close edit API form" onClick={closeModal}>×</button></div>
          <p className="modal-copy" id="edit-api-description">Save corrected catalog details. The editor and date will be recorded in this API’s history.</p>
          <form onSubmit={submitEdit} className="api-form">
            <p className="edit-warning full">Editing verified API content returns it to awaiting verification. The API remains publicly listed while it is checked again.</p>
            <label><span>API name (readable English) *</span><input data-modal-autofocus required maxLength={180} value={draft.api_name} onChange={(event) => setDraft({ ...draft, api_name: event.target.value })} /></label>
            <label><span>Official API/service name</span><input maxLength={240} lang="und" value={draft.official_api_name} onChange={(event) => setDraft({ ...draft, official_api_name: event.target.value })} /></label>
            <label><span>Company (English + abbreviation) *</span><input required maxLength={180} value={draft.company_name} onChange={(event) => setDraft({ ...draft, company_name: event.target.value })} /></label>
            <label><span>Official company name</span><input maxLength={240} lang="und" value={draft.official_company_name} onChange={(event) => setDraft({ ...draft, official_company_name: event.target.value })} /></label>
            <label className="full"><span>Country / region</span><input maxLength={120} placeholder="For example: Australia, European Union, or Global" aria-describedby="country-region-help" value={draft.country_region} onChange={(event) => setDraft({ ...draft, country_region: event.target.value })} /><small id="country-region-help">Record the country or service region supported by the documentation. Leave blank if it is unknown; a provider’s address alone does not establish coverage.</small></label>
            <label className="full"><span>Description *</span><textarea required rows={4} maxLength={2_000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            <label className="full"><span>API endpoint *</span><input required type="text" inputMode="url" maxLength={2_000} value={draft.api_endpoint} onChange={(event) => setDraft({ ...draft, api_endpoint: event.target.value })} /></label>
            <label className="full"><span>Official documentation *</span><input required type="url" maxLength={2_000} value={draft.documentation_url} onChange={(event) => setDraft({ ...draft, documentation_url: event.target.value })} /></label>
            <label><span>Category</span><select value={draft.category} onChange={(event) => { const next = event.target.value as ApiSubmission["category"]; setDraft({ ...draft, category: next, category_other: next === "Other" ? draft.category_other : "", communication_direction: next === "Communication" ? (draft.communication_direction || "Unspecified") : "" }); }}>{API_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
            {draft.category === "Communication" && <label><span>Communication direction</span><select value={draft.communication_direction} onChange={(event) => setDraft({ ...draft, communication_direction: event.target.value as CommunicationDirection })}>{COMMUNICATION_DIRECTIONS.map((item) => <option key={item} value={item}>{item === "Send and receive" ? "Send & receive" : item}</option>)}</select></label>}
            <label><span>Authentication</span><select value={draft.authentication_method} onChange={(event) => setDraft({ ...draft, authentication_method: event.target.value as ApiSubmission["authentication_method"], authentication_other: event.target.value === "Other" ? draft.authentication_other : "" })}>{AUTHENTICATION_TYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
            {draft.category === "Other" && <label><span>Other category *</span><input required maxLength={100} value={draft.category_other} onChange={(event) => setDraft({ ...draft, category_other: event.target.value })} /></label>}
            {draft.authentication_method === "Other" && <label><span>Other authentication *</span><input required maxLength={120} value={draft.authentication_other} onChange={(event) => setDraft({ ...draft, authentication_other: event.target.value })} /></label>}
            <label className="full"><span>Authentication details</span><textarea rows={3} maxLength={1_000} value={draft.authentication_details} onChange={(event) => setDraft({ ...draft, authentication_details: event.target.value })} /></label>
            <fieldset className="api-metadata-editor full"><legend>Integration details</legend>
              <label><span>HTTP method</span><select value={draft.http_method ?? ""} onChange={(event) => setDraft({ ...draft, http_method: event.target.value })}><option value="">Not recorded</option>{HTTP_METHODS.map((method) => <option key={method}>{method}</option>)}</select></label>
              <label><span>Provider access</span><select value={draft.access_scope ?? "unknown"} onChange={(event) => setDraft({ ...draft, access_scope: event.target.value as ApiRecord["access_scope"] })}><option value="unknown">Not recorded</option><option value="public">Publicly offered</option><option value="restricted">Restricted / internal</option></select></label>
              {([['input_formats', 'Input formats', 'JSON, XML'], ['output_formats', 'Output formats', 'JSON, XML'], ['invoice_standard', 'Invoice standards', 'UBL, PEPPOL'], ['client_types', 'Client / interface types', 'REST, SOAP']] as const).map(([key, label, placeholder]) => <label key={key}><span>{label}</span><input maxLength={2_000} placeholder={placeholder} value={(draft[key] ?? []).join(', ')} onChange={(event) => setDraft({ ...draft, [key]: event.target.value.split(',').map((value) => value.trim()) })} /><small>Separate values with commas.</small></label>)}
              <label><span>Network</span><input maxLength={200} value={draft.network ?? ""} onChange={(event) => setDraft({ ...draft, network: event.target.value })} /></label>
              <label><span>Provider website</span><input type="url" maxLength={2_000} value={draft.website_url ?? ""} onChange={(event) => setDraft({ ...draft, website_url: event.target.value })} /></label>
              <label className="full"><span>Implementation notes</span><textarea rows={3} maxLength={4_000} value={draft.instructions ?? ""} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
              <label className="full"><span>Business rules · one per line</span><textarea rows={3} maxLength={10_000} value={(draft.business_rules ?? []).join('\n')} onChange={(event) => setDraft({ ...draft, business_rules: event.target.value.split('\n') })} /></label>
            </fieldset>
            {formError && <p className="form-error full" role="alert">{formError}</p>}
            <div className="form-footer full"><span>This edit will be recorded with your account.</span><div><button className="button secondary" type="button" onClick={closeModal} disabled={submitting}>Cancel</button><button className="button primary" type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save changes"}</button></div></div>
          </form>
        </section>
      </div>}

      {notice && <div className={`toast ${notice.kind === "error" ? "error" : ""}`} role="status">{notice.message}</div>}
    </main>
  );
}
