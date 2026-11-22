/**
 * Server-rendered markup for the Models page.
 *
 * The catalog is the one thing the dashboard used to ask for as JSON. It is DeepAI's list,
 * every visitor may see it, and answering it as a document is both cheaper to read and
 * impossible to mistake for an API: there is no model endpoint left to poll, cache or
 * resell - a page is a page. The same markup feeds the model picker in the key form, so the
 * dashboard needs no catalog fetch of its own.
 *
 * Strings come from the same `public/locales/<code>.json` the client loads, so the page
 * arrives in the visitor's language instead of being translated after paint. Every label is
 * also tagged with `data-i18n`, so switching language on the page still works.
 *
 * @module deepai-gateway/web/render
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { displayName } from '../deepai/catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', '..', 'public', 'locales');

/** The languages the dashboard speaks, matching `public/locales`. */
export const LOCALE_CODES = Object.freeze(['en', 'pl', 'de', 'es', 'hi']);

/** Cookie the client mirrors its chosen language into, so the server can render it. */
export const LOCALE_COOKIE = 'deepai_gateway_locale';

const DEFAULTS = new Map();

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/** The strings for one language, read once and kept. */
function stringsFor(code) {
  const known = LOCALE_CODES.includes(code) ? code : 'en';
  if (DEFAULTS.has(known)) return DEFAULTS.get(known);
  let table = {};
  try {
    table = JSON.parse(readFileSync(join(LOCALES, `${known}.json`), 'utf8'));
  } catch {
    // A missing or broken file falls back to English rather than to nothing; the client
    // does the same, and neither is a reason to fail the page.
    table = {};
  }
  DEFAULTS.set(known, table);
  return table;
}

/**
 * Which language to draw the page in.
 *
 * The client's choice lives in `localStorage`, which the server cannot see, so the client
 * mirrors it into a cookie as well. Failing that, the browser's own preferences decide -
 * the same rule the dashboard uses on a first visit - and English is the last resort.
 *
 * @param {import('express').Request} req
 * @returns {string} a code from {@link LOCALE_CODES}.
 */
export function localeFor(req) {
  const cookie = req.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`).exec(cookie);
  if (match !== null) {
    const chosen = decodeURIComponent(match[1]);
    if (LOCALE_CODES.includes(chosen)) return chosen;
  }
  const accept = String(req.get('accept-language') ?? '').toLowerCase();
  for (const part of accept.split(',')) {
    const code = part.split(';')[0].trim().split('-')[0];
    if (LOCALE_CODES.includes(code)) return code;
  }
  return 'en';
}

/**
 * Build `t()` for one language.
 *
 * Same shape and same `{placeholder}` syntax as the client's, so one locale file serves both
 * and a translator edits one place. An unknown key renders as the key, which is how a
 * missing string becomes visible instead of silently empty.
 *
 * @param {string} code
 * @returns {(key: string, vars?: object) => string}
 */
export function translator(code) {
  const table = stringsFor(code);
  const fallback = stringsFor('en');
  return (key, vars = {}) => {
    const raw = table[key] ?? fallback[key] ?? key;
    if (typeof raw !== 'string') return key;
    return raw.replace(/\{(\w+)\}/g, (whole, name) => (
      Object.hasOwn(vars, name) ? String(vars[name]) : whole
    ));
  };
}

/** A token count the way the dashboard writes one: `1.05M`, `104k`, `900`. */
function tokens(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** A metric card, mirroring the client's. */
function metricCard(t, { eyebrow, value, label }) {
  return `
    <div class="card">
      <div class="eyebrow">${escapeHtml(eyebrow)}</div>
      <div class="metric__value mt-2">${escapeHtml(value)}</div>
      <div class="metric__label">${escapeHtml(label)}</div>
    </div>`;
}

/**
 * The Models page body.
 *
 * `usage` holds one row per model with the account's traffic through this gateway, or is
 * `null` for a visitor who is not signed in - the catalog is public, the usage beside it is
 * not, so an anonymous reader gets the same table without the last column.
 *
 * @param {object} options
 * @param {Array<object>} options.models - as shaped by `publicModel`.
 * @param {Map<string, {totalTokens: number}>|null} [options.usage]
 * @param {(key: string, vars?: object) => string} options.t
 * @returns {string} markup for `#view`.
 */
export function modelsView({ models, usage = null, t }) {
  const free = models.filter((model) => !model.premier);
  const premier = models.filter((model) => model.premier);

  const row = (model) => `
    <tr>
      <td>
        <div class="model-row">
          <div>
            <div class="model-row__name">${escapeHtml(model.displayName)}</div>
            <div class="tiny muted mono">${escapeHtml(model.id)}</div>
          </div>
        </div>
      </td>
      <td><span class="badge ${model.premier ? 'badge--violet' : 'badge--green'}">${t(model.premier ? 'common.premium' : 'common.free')}</span></td>
      <td class="num tiny muted">${escapeHtml(tokens(model.contextWindow))}</td>
      <td class="num tiny muted">${escapeHtml(tokens(model.maxTokens))}</td>
      <td class="tiny muted">${model.reasoning ? 'none, low, medium, high' : '-'}</td>
      <td class="tiny muted">${model.input.includes('image') ? 'text, image' : 'text'}</td>
      <td class="num tiny muted">${model.premier ? escapeHtml(model.rateLabel) : t('common.unmetered')}</td>
      ${usage === null
        ? ''
        : `<td class="num tiny">${usage.get(model.id)
          ? (Number(usage.get(model.id).totalTokens) || 0).toLocaleString('en-US')
          : '<span class="muted">-</span>'}</td>`}
    </tr>`;

  const usedHeader = usage === null ? '' : `<th class="num">${t('metric.used')}</th>`;

  return `
    <div class="page__head">
      <h1 class="page__title" data-i18n="models.title">${t('models.title')}</h1>
      <p class="page__sub" data-i18n="models.subtitle">${t('models.subtitle')}</p>
    </div>

    <div class="stack">
      <div class="grid grid--3">
        ${metricCard(t, { eyebrow: t('metric.catalog'), value: String(models.length), label: t('metric.modelsAvailable') })}
        ${metricCard(t, { eyebrow: t('metric.freeTier'), value: String(free.length), label: t('metric.unmeteredModels') })}
        ${metricCard(t, { eyebrow: t('common.premium'), value: String(premier.length), label: t('common.billedInCredits') })}
      </div>

      <div class="card card--flush">
        <div class="card__head">
          <div>
            <div class="card__title">${t('common.allModels')}</div>
            <div class="card__sub">${t('models.usedNote')}</div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>${t('metric.model')}</th><th>${t('metric.tier')}</th><th class="num">${t('metric.context')}</th><th class="num">${t('metric.maxOut')}</th>
              <th class="hide-sm">${t('metric.reasoning')}</th><th class="hide-sm">${t('metric.input')}</th><th class="num">${t('metric.rate')}</th>${usedHeader}
            </tr></thead>
            <tbody>${models.map(row).join('')}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">${t('models.howBilling')}</div>
        <p class="muted mt-2" style="font-size:13px;max-width:78ch">
          ${t('models.billing', { free: t('common.free') })}
        </p>
      </div>
    </div>`;
}

/**
 * The body to draw when the catalog cannot be read.
 *
 * Names the failure in the visitor's language and puts the reason underneath in the language
 * the gateway logged it in: the first line is what a reader needs, the second is what an
 * operator needs, and inventing a translation for the second would only hide it.
 *
 * @param {{t: (key: string, vars?: object) => string, reason: string}} options
 * @returns {string}
 */
export function modelsUnavailableView({ t, reason }) {
  return `
    <div class="page__head">
      <h1 class="page__title" data-i18n="models.title">${t('models.title')}</h1>
      <p class="page__sub" data-i18n="models.subtitle">${t('models.subtitle')}</p>
    </div>

    <div class="note note--error">
      <div>${t('models.unavailable')}</div>
      <div class="tiny muted mono mt-2">${escapeHtml(reason)}</div>
    </div>`;
}

/**
 * The model picker for the key form, rendered once into the shell.
 *
 * The dashboard needs the catalog for one more thing - choosing which models a key may use -
 * and a JSON call for that would have been the model endpoint again under another name. The
 * pills are drawn with the page instead, and the client clones them; the ids and tiers ride
 * along as data attributes so the form can preselect the free ones without knowing the list.
 *
 * The label is the one the Models page uses, from the same `displayName`, because a pill and a
 * row describe the same model - and the pill is the only place its name appears when a key is
 * being made.
 *
 * @param {Array<object>} models - catalog models, as `catalogSnapshot` keeps them.
 * @returns {string} markup to place inside the `<template>`.
 */
export function modelPills(models) {
  return models.map((model) => (
    `<button type="button" class="pill" data-model="${escapeHtml(model.id)}" `
    + `data-premier="${model.premier === true}">${escapeHtml(displayName(model))}</button>`
  )).join('');
}
