"use client";

import { useEffect, useId, useRef, useState } from "react";
import { API_CATEGORIES, type ApiCategory } from "@/lib/types";
import {
  ALL_CATEGORIES,
  ALL_COMMUNICATION_DIRECTIONS,
  CATALOG_COMMUNICATION_SUBCATEGORIES,
  catalogueCategoryLabel,
  type CatalogueCategory,
  type CatalogueCommunicationDirection,
} from "@/lib/catalog-category-filter";

type CatalogCategoryFilterProps = {
  category: CatalogueCategory;
  communicationDirection: CatalogueCommunicationDirection;
  onChange: (
    category: CatalogueCategory,
    communicationDirection: CatalogueCommunicationDirection,
  ) => void;
};

const TOP_LEVEL_CATEGORIES = API_CATEGORIES.filter(
  (category): category is Exclude<ApiCategory, "Communication"> => category !== "Communication",
);

export default function CatalogCategoryFilter({
  category,
  communicationDirection,
  onChange,
}: CatalogCategoryFilterProps) {
  const [open, setOpen] = useState(false);
  const [communicationOpen, setCommunicationOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const communicationItemRef = useRef<HTMLButtonElement>(null);
  const firstSubcategoryRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const labelId = useId();

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setCommunicationOpen(false);
      }
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      setOpen(false);
      setCommunicationOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  function openMenu(focusFirst = false) {
    setOpen(true);
    setCommunicationOpen(category === "Communication");
    if (focusFirst) {
      window.requestAnimationFrame(() => firstItemRef.current?.focus());
    }
  }

  function select(
    nextCategory: CatalogueCategory,
    nextDirection: CatalogueCommunicationDirection = ALL_COMMUNICATION_DIRECTIONS,
  ) {
    onChange(nextCategory, nextDirection);
    setOpen(false);
    setCommunicationOpen(false);
    triggerRef.current?.focus();
  }

  function showCommunicationSubmenu(focusFirst = false) {
    setCommunicationOpen(true);
    if (focusFirst) {
      window.requestAnimationFrame(() => firstSubcategoryRef.current?.focus());
    }
  }

  return (
    <div
      className="category-filter-field"
      ref={rootRef}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
        setCommunicationOpen(false);
      }}
    >
      <span className="category-filter-label" id={labelId}>Category</span>
      <button
        type="button"
        className="category-filter-trigger"
        ref={triggerRef}
        aria-labelledby={`${labelId} ${menuId}-value`}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (open) {
            setOpen(false);
            setCommunicationOpen(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu(true);
          }
        }}
      >
        <span id={`${menuId}-value`}>{catalogueCategoryLabel(category, communicationDirection)}</span>
        <span className="category-filter-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <div className="category-filter-menu" id={menuId} role="group" aria-labelledby={labelId}>
          <button
            type="button"
            className={category === ALL_CATEGORIES ? "selected" : ""}
            aria-pressed={category === ALL_CATEGORIES}
            ref={firstItemRef}
            onClick={() => select(ALL_CATEGORIES)}
          >
            <span>All categories</span><span className="category-filter-check" aria-hidden="true">✓</span>
          </button>

          <div
            className="category-menu-communication"
            onMouseEnter={() => setCommunicationOpen(true)}
            onMouseLeave={() => setCommunicationOpen(false)}
          >
            <div className="category-menu-parent-row">
              <button
                type="button"
                className={category === "Communication" && communicationDirection === ALL_COMMUNICATION_DIRECTIONS ? "selected" : ""}
                aria-pressed={category === "Communication" && communicationDirection === ALL_COMMUNICATION_DIRECTIONS}
                ref={communicationItemRef}
                onFocus={() => setCommunicationOpen(true)}
                onClick={() => select("Communication")}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    showCommunicationSubmenu(true);
                  }
                }}
              >
                <span>Communication</span><span className="category-filter-check" aria-hidden="true">✓</span>
              </button>
              <button
                type="button"
                className="category-submenu-toggle"
                aria-label={`${communicationOpen ? "Hide" : "Show"} Communication subcategories`}
                aria-expanded={communicationOpen}
                aria-controls={`${menuId}-communication`}
                onClick={() => setCommunicationOpen((current) => !current)}
              >
                <span aria-hidden="true">›</span>
              </button>
            </div>

            {communicationOpen && (
              <div
                className="category-filter-submenu"
                id={`${menuId}-communication`}
                role="group"
                aria-label="Communication subcategories"
              >
                {CATALOG_COMMUNICATION_SUBCATEGORIES.map((direction, index) => (
                  <button
                    type="button"
                    className={category === "Communication" && communicationDirection === direction ? "selected" : ""}
                    aria-pressed={category === "Communication" && communicationDirection === direction}
                    ref={index === 0 ? firstSubcategoryRef : undefined}
                    key={direction}
                    onClick={() => select("Communication", direction)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        setCommunicationOpen(false);
                        communicationItemRef.current?.focus();
                      }
                    }}
                  >
                    <span>{direction}</span><span className="category-filter-check" aria-hidden="true">✓</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {TOP_LEVEL_CATEGORIES.map((item) => (
            <button
              type="button"
              className={category === item ? "selected" : ""}
              aria-pressed={category === item}
              key={item}
              onFocus={() => setCommunicationOpen(false)}
              onClick={() => select(item)}
            >
              <span>{item}</span><span className="category-filter-check" aria-hidden="true">✓</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
