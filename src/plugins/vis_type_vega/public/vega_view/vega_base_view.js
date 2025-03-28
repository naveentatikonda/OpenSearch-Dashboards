/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import $ from 'jquery';
import moment from 'moment';
import dateMath from '@elastic/datemath';
import { vega, vegaLite, vegaExpressionInterpreter } from '../lib/vega';
import { Utils } from '../data_model/utils';
import { euiPaletteColorBlind } from '@elastic/eui';
import { i18n } from '@osd/i18n';
import { TooltipHandler } from './vega_tooltip';
import { opensearchFilters } from '../../../data/public';

import { getEnableExternalUrls, getData } from '../services';
import { extractIndexPatternsFromSpec } from '../lib/extract_index_pattern';

vega.scheme('elastic', euiPaletteColorBlind());

// Vega's extension functions are global. When called,
// we forward execution to the instance-specific handler
// This functions must be declared in the VegaBaseView class
const vegaFunctions = {
  opensearchDashboardsAddFilter: 'addFilterHandler',
  opensearchDashboardsRemoveFilter: 'removeFilterHandler',
  opensearchDashboardsRemoveAllFilters: 'removeAllFiltersHandler',
  opensearchDashboardsSetTimeFilter: 'setTimeFilterHandler',
};

for (const funcName of Object.keys(vegaFunctions)) {
  if (!vega.expressionFunction(funcName)) {
    vega.expressionFunction(funcName, function handlerFwd(...args) {
      const view = this.context.dataflow;
      view.runAfter(() => view._opensearchDashboardsView.vegaFunctionsHandler(funcName, ...args));
    });
  }
}

const bypassToken = Symbol();

export function bypassExternalUrlCheck(url) {
  // processed in the  loader.sanitize  below
  return { url, bypassToken };
}

export class VegaBaseView {
  constructor(opts) {
    this._$parentEl = $(opts.parentEl);
    this._parser = opts.vegaParser;
    this._serviceSettings = opts.serviceSettings;
    this._filterManager = opts.filterManager;
    this._applyFilter = opts.applyFilter;
    this._timefilter = opts.timefilter;
    this._view = null;
    this._vegaViewConfig = null;
    this._vegaViewOptions = null;
    this._$messages = null;
    this._destroyHandlers = [];
    this._initialized = false;
    this._enableExternalUrls = getEnableExternalUrls();
  }

  async init() {
    if (this._initialized) throw new Error(); // safety
    this._initialized = true;

    try {
      this._$parentEl.empty().addClass(`vgaVis`).css('flex-direction', this._parser.containerDir);

      // bypass the onWarn warning checks - in some cases warnings may still need to be shown despite being disabled
      for (const warn of this._parser.warnings) {
        this._addMessage('warn', warn);
      }

      if (this._parser.error) {
        this._addMessage('err', this._parser.error);
        return;
      }

      this._$container = $('<div class="vgaVis__view">')
        // Force a height here because css is not loaded in mocha test
        .css('height', '100%')
        .appendTo(this._$parentEl);
      this._$controls = $(
        `<div class="vgaVis__controls vgaVis__controls--${this._parser.controlsDir}">`
      ).appendTo(this._$parentEl);

      this._addDestroyHandler(() => {
        if (this._$container) {
          this._$container.remove();
          this._$container = null;
        }
        if (this._$controls) {
          this._$controls.remove();
          this._$controls = null;
        }
        if (this._$messages) {
          this._$messages.remove();
          this._$messages = null;
        }
        if (this._view) {
          this._view.finalize();
        }
        this._view = null;
      });

      this._vegaViewConfig = this.createViewConfig();
      this._vegaViewOptions = { ast: true };

      // The derived class should create this method
      await this._initViewCustomizations();
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * Find index pattern by its title, if not given, gets it from spec or a defaults one
   * @param {string} [index]
   * @returns {Promise<string>} index id
   */
  async findIndex(index) {
    const { indexPatterns } = getData();
    let idxObj;

    if (index) {
      [idxObj] = await indexPatterns.find(index);
      if (!idxObj) {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.baseView.indexNotFoundErrorMessage', {
            defaultMessage: 'Index {index} not found',
            values: { index: `"${index}"` },
          })
        );
      }
    } else {
      [idxObj] = await extractIndexPatternsFromSpec(
        this._parser.isVegaLite ? this._parser.vlspec : this._parser.spec
      );

      if (!idxObj) {
        const defaultIdx = await indexPatterns.getDefault();

        if (defaultIdx) {
          idxObj = defaultIdx;
        } else {
          throw new Error(
            i18n.translate('visTypeVega.vegaParser.baseView.unableToFindDefaultIndexErrorMessage', {
              defaultMessage: 'Unable to find default index',
            })
          );
        }
      }
    }

    return idxObj.id;
  }

  createViewConfig() {
    const config = {
      // eslint-disable-next-line import/namespace
      logLevel: vega.Warn, // note: eslint has a false positive here
      renderer: this._parser.renderer,
      expr: vegaExpressionInterpreter,
    };

    // Override URL sanitizer to prevent external data loading (if disabled)
    const loader = vega.loader();
    const originalSanitize = loader.sanitize.bind(loader);
    loader.sanitize = (uri, options) => {
      if (uri.bypassToken === bypassToken) {
        // If uri has a bypass token, the uri was encoded by bypassExternalUrlCheck() above.
        // because user can only supply pure JSON data structure.
        uri = uri.url;
      } else if (!this._enableExternalUrls) {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.baseView.externalUrlsAreNotEnabledErrorMessage', {
            defaultMessage:
              'External URLs are not enabled. Add   {enableExternalUrls}   to {opensearchDashboardsConfigFileName}',
            values: {
              enableExternalUrls: 'vis_type_vega.enableExternalUrls: true',
              opensearchDashboardsConfigFileName: 'opensearch_dashboards.yml',
            },
          })
        );
      }
      return originalSanitize(uri, options);
    };
    config.loader = loader;

    return config;
  }

  onError() {
    this._addMessage('err', Utils.formatErrorToStr(...arguments));
  }

  onWarn() {
    if (!this._parser || !this._parser.hideWarnings) {
      this._addMessage('warn', Utils.formatWarningToStr(...arguments));
    }
  }

  _addMessage(type, text) {
    if (!this._$messages) {
      this._$messages = $(`<ul class="vgaVis__messages">`).appendTo(this._$parentEl);
    }
    this._$messages.append(
      $(`<li class="vgaVis__message vgaVis__message--${type}">`).append(
        $(`<pre class="vgaVis__messageCode">`).text(text)
      )
    );
  }

  resize() {
    if (this._parser.useResize && this._view && this.updateVegaSize(this._view)) {
      return this._view.runAsync();
    }
  }

  updateVegaSize(view) {
    // For some reason the object is slightly scrollable without the extra padding.
    // This might be due to https://github.com/jquery/jquery/issues/3808
    // Which is being fixed as part of jQuery 3.3.0
    const heightExtraPadding = 6;
    const width = Math.max(0, this._$container.width());
    const height = Math.max(0, this._$container.height()) - heightExtraPadding;

    if (view.width() !== width || view.height() !== height) {
      view.width(width).height(height);
      return true;
    }
    return false;
  }

  setView(view) {
    if (this._view === view) return;

    if (this._view) {
      this._view.finalize();
    }

    this._view = view;

    if (view) {
      // Global vega expression handler uses it to call custom functions
      view._opensearchDashboardsView = this;

      if (this._parser.tooltips) {
        // position and padding can be specified with
        // {config:{kibana:{tooltips: {position: 'top', padding: 15 } }}}
        const tthandler = new TooltipHandler(this._$container[0], view, this._parser.tooltips);

        // Vega bug workaround - need to destroy tooltip by hand
        this._addDestroyHandler(() => tthandler.hideTooltip());
      }

      return view.runAsync(); // Allows callers to await rendering
    }
  }

  /**
   * Handle
   * @param funcName
   * @param args
   * @returns {Promise<void>}
   */
  async vegaFunctionsHandler(funcName, ...args) {
    try {
      const handlerFunc = vegaFunctions[funcName];
      if (!handlerFunc || !this[handlerFunc]) {
        // in case functions don't match the list above
        throw new Error(
          i18n.translate(
            'visTypeVega.vegaParser.baseView.functionIsNotDefinedForGraphErrorMessage',
            {
              defaultMessage: '{funcName} is not defined for this graph',
              values: { funcName: `${funcName}()` },
            }
          )
        );
      }
      await this[handlerFunc](...args);
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * @param {object} query Query DSL snippet, as used in the query DSL editor
   * @param {string} [index] as defined in OpenSearch Dashboards, or default if missing
   * @param {string} alias OpenSearch Query DSL's custom label for `opensearchDashboardsAddFilter`, as used in '+ Add Filter'
   */
  async addFilterHandler(query, index, alias) {
    const indexId = await this.findIndex(Utils.handleNonStringIndex(index));
    const filter = opensearchFilters.buildQueryFilter(
      Utils.handleInvalidQuery(query),
      indexId,
      alias
    );
    this._applyFilter({ filters: [filter] });
  }

  /**
   * @param {object} query Query DSL snippet, as used in the query DSL editor
   * @param {string} [index] as defined in OpenSearch Dashboards, or default if missing
   */
  async removeFilterHandler(query, index) {
    const indexId = await this.findIndex(Utils.handleNonStringIndex(index));
    const filterToRemove = opensearchFilters.buildQueryFilter(
      Utils.handleInvalidQuery(query),
      indexId
    );

    const currentFilters = this._filterManager.getFilters();
    const existingFilter = currentFilters.find((filter) =>
      opensearchFilters.compareFilters(filter, filterToRemove)
    );

    if (!existingFilter) return;

    try {
      this._filterManager.removeFilter(existingFilter);
    } catch (err) {
      this.onError(err);
    }
  }

  removeAllFiltersHandler() {
    this._filterManager.removeAll();
  }

  /**
   * Update dashboard time filter to the new values
   * @param {number|string|Date} start
   * @param {number|string|Date} end
   */
  setTimeFilterHandler(start, end) {
    const { from, to, mode } = VegaBaseView._parseTimeRange(
      Utils.handleInvalidDate(start),
      Utils.handleInvalidDate(end)
    );

    this._applyFilter({
      timeFieldName: '*',
      filters: [
        {
          range: {
            '*': {
              mode,
              gte: from,
              lte: to,
            },
          },
        },
      ],
    });
  }

  /**
   * Parse start and end values, determining the mode, and if order should be reversed
   * @private
   */
  static _parseTimeRange(start, end) {
    const absStart = moment(start);
    const absEnd = moment(end);
    const isValidAbsStart = absStart.isValid();
    const isValidAbsEnd = absEnd.isValid();
    let mode = 'absolute';
    let from;
    let to;
    let reverse;

    if (isValidAbsStart && isValidAbsEnd) {
      // Both are valid absolute dates.
      from = absStart;
      to = absEnd;
      reverse = absStart.isAfter(absEnd);
    } else {
      // Try to parse as relative dates too (absolute dates will also be accepted)
      const startDate = dateMath.parse(start);
      const endDate = dateMath.parse(end);
      if (!startDate || !endDate || !startDate.isValid() || !endDate.isValid()) {
        throw new Error(
          i18n.translate('visTypeVega.vegaParser.baseView.timeValuesTypeErrorMessage', {
            defaultMessage:
              'Error setting time filter: both time values must be either relative or absolute dates. {start}, {end}',
            values: {
              start: `start=${JSON.stringify(start)}`,
              end: `end=${JSON.stringify(end)}`,
            },
          })
        );
      }
      reverse = startDate.isAfter(endDate);
      if (isValidAbsStart || isValidAbsEnd) {
        // Mixing relative and absolute - treat them as absolute
        from = startDate;
        to = endDate;
      } else {
        // Both dates are relative
        mode = 'relative';
        from = start;
        to = end;
      }
    }

    if (reverse) {
      [from, to] = [to, from];
    }

    return { from, to, mode };
  }

  /**
   * Set global debug variable to simplify vega debugging in console. Show info message first time
   */
  setDebugValues(view, spec, vlspec) {
    this._parser.searchAPI.inspectorAdapters?.vega.bindInspectValues({
      view,
      spec: vlspec || spec,
    });

    if (window) {
      if (window.VEGA_DEBUG === undefined && console) {
        console.log(
          '%cWelcome to OpenSearch Dashboards Vega Plugin!',
          'font-size: 16px; font-weight: bold;'
        );
        console.log(
          'You can access the Vega view with VEGA_DEBUG. ' +
            'Learn more at https://vega.github.io/vega/docs/api/debugging/.'
        );
      }
      const debugObj = {};
      window.VEGA_DEBUG = debugObj;
      window.VEGA_DEBUG.VEGA_VERSION = vega.version;
      window.VEGA_DEBUG.VEGA_LITE_VERSION = vegaLite.version;
      window.VEGA_DEBUG.view = view;
      window.VEGA_DEBUG.vega_spec = spec;
      window.VEGA_DEBUG.vegalite_spec = vlspec;

      // On dispose, clean up, but don't use undefined to prevent repeated debug statements
      this._addDestroyHandler(() => {
        if (debugObj === window.VEGA_DEBUG) {
          window.VEGA_DEBUG = null;
        }
      });
    }
  }

  destroy() {
    // properly handle multiple destroy() calls by converting this._destroyHandlers
    // into the _ongoingDestroy promise, while handlers are being disposed
    if (this._destroyHandlers) {
      // If no destroy is yet running, execute all handlers and wait for all of them to resolve.
      this._ongoingDestroy = Promise.all(this._destroyHandlers.map((v) => v()));
      this._destroyHandlers = null;
    }
    return this._ongoingDestroy;
  }

  _addDestroyHandler(handler) {
    // If disposing hasn't started yet, enqueue it, otherwise dispose right away
    // This creates a minor issue - if disposing has started but not yet finished,
    // and we dispose the new handler right away, the destroy() does not wait for it.
    // This behavior is no different from the case when disposing has already completed,
    // so it shouldn't create any issues.
    if (this._destroyHandlers) {
      this._destroyHandlers.push(handler);
    } else {
      handler();
    }
  }
}
