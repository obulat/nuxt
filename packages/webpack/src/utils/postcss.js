import fs from 'fs'
import path from 'path'
import consola from 'consola'
import { defaults, merge, cloneDeep } from 'lodash'
import createResolver from 'postcss-import-resolver'

import { isPureObject } from '@nuxt/utils'

export const orderPresets = {
  cssnanoLast (names) {
    const nanoIndex = names.indexOf('cssnano')
    if (nanoIndex !== names.length - 1) {
      names.push(names.splice(nanoIndex, 1)[0])
    }
    return names
  },
  presetEnvLast (names) {
    const nanoIndex = names.indexOf('postcss-preset-env')
    if (nanoIndex !== names.length - 1) {
      names.push(names.splice(nanoIndex, 1)[0])
    }
    return names
  },
  presetEnvAndCssnanoLast (names) {
    return orderPresets.cssnanoLast(orderPresets.presetEnvLast(names))
  }
}

function postcssConfigFileWarning () {
  if (postcssConfigFileWarning.executed) {
    return
  }
  consola.warn('Please use `build.postcss` in your nuxt.config.js instead of an external config file. Support for such files will be removed in Nuxt 3 as they remove all defaults set by Nuxt and can cause severe problems with features like alias resolving inside your CSS.')
  postcssConfigFileWarning.executed = true
}

export default class PostcssConfig {
  constructor (buildContext) {
    this.buildContext = buildContext
  }

  get cssSourceMap () {
    return this.buildContext.buildOptions.cssSourceMap
  }

  get postcssLoaderOptions () {
    return this.buildContext.buildOptions.postcss
  }

  get postcssOptions () {
    return this.buildContext.buildOptions.postcss.postcssOptions
  }

  get postcssImportAlias () {
    const alias = { ...this.buildContext.options.alias }

    for (const key in alias) {
      if (key.startsWith('~')) {
        continue
      }
      const newKey = '~' + key
      if (!alias[newKey]) {
        alias[newKey] = alias[key]
      }
    }

    return alias
  }

  get defaultPostcssOptions () {
    const { dev, srcDir, rootDir, modulesDir } = this.buildContext.options
    return {
      plugins: {
        // https://github.com/postcss/postcss-import
        'postcss-import': {
          resolve: createResolver({
            alias: this.postcssImportAlias,
            modules: [srcDir, rootDir, ...modulesDir]
          })
        },

        // https://github.com/csstools/postcss-plugins/plugin-packs/postcss-url
        'postcss-url': {},

        // https://github.com/csstools/postcss-plugins/plugin-packs/postcss-preset-env
        'postcss-preset-env': this.postcssOptions.preset || {},

        cssnano: dev
          ? false
          : {
            preset: ['default', {
              // Keep quotes in font values to prevent from HEX conversion
              // https://github.com/nuxt/nuxt.js/issues/6306
              minifyFontValues: { removeQuotes: false }
            }]
          }
      },
      // Array, String or Function
      order: 'presetEnvAndCssnanoLast'
    }
  }

  searchConfigFile () {
    // Search for postCSS config file and use it if exists
    // https://github.com/michael-ciniawsky/postcss-load-config
    // TODO: Remove in Nuxt 3
    const { srcDir, rootDir } = this.buildContext.options
    for (const dir of [srcDir, rootDir]) {
      for (const file of [
        'postcss.config.js',
        '.postcssrc.js',
        '.postcssrc',
        '.postcssrc.json',
        '.postcssrc.yaml'
      ]) {
        const configFile = path.resolve(dir, file)
        if (fs.existsSync(configFile)) {
          postcssConfigFileWarning()
          return configFile
        }
      }
    }
  }

  configFromFile () {
    const loaderConfig = (this.postcssOptions && this.postcssOptions.config) || {}

    if (loaderConfig.path) {
      consola.warn('`postcss-loader` has been removed `config.path` option, please use `config` instead.')
      return {
        config: loaderConfig.path
      }
    }

    const postcssConfigFile = this.searchConfigFile()

    if (postcssConfigFile) {
      return {
        config: postcssConfigFile
      }
    }
  }

  /**
   * Converts the old syntax to the one expected by Nuxt ^2.16.
   * - `Array` to `{ plugins: [] }`
   * - `Boolean` to `{ plugins: {} }` (default plugins) or `{ plugins: false }` (no plugins)
   * - Moves the `preset`, `order` and `plugins` to the inner `postcssOptions` object
   * - Does not convert an Array of plugins to an object
   * @param postcssOptions
   * @returns {{ postcssOptions: { plugins?: unknown, order?: string, preset?: any} }}
   */
  normalize (postcssOptions) {
    // TODO: Remove in Nuxt 3
    if (Array.isArray(postcssOptions)) {
      consola.warn('Using an Array as `build.postcss` will be deprecated in Nuxt 3. Please switch to the object' +
        ' declaration')
      return { postcssOptions: { plugins: postcssOptions } }
    } else if (typeof postcssOptions === 'boolean') {
      consola.warn('Using a Boolean as `build.postcss` will be deprecated in Nuxt 3. Please switch to the object' +
        ' declaration')
      return { postcssOptions: { plugins: postcssOptions ? {} : false } }
    } else if (!isPureObject(postcssOptions)) {
      return { postcssOptions: {} }
    }
    if (postcssOptions.postcssOptions && typeof postcssOptions.postcssOptions === 'function') {
      consola.warn('Using a Function as `build.postcss.postcssOptions` is not yet supported in Nuxt 2.16.2')
      return { postcssOptions: {} }
    }
    if (!('postcssOptions' in postcssOptions)) {
      if (Object.keys(postcssOptions).length > 0) {
        consola.warn('Using the top-level properties in `build.postcss` will be deprecated in Nuxt 3. Please move' +
          'the settings to `postcss.postcssOptions`')
      }
      postcssOptions = { postcssOptions: {}}
    }
    // The plugins and preset are merged, with priority to the inner `postcssOptions`
    if (postcssOptions.plugins) {
      postcssOptions.postcssOptions.plugins = merge(postcssOptions.postcssOptions.plugins, postcssOptions.plugins)
      delete postcssOptions.plugins
    }
    // The preset is merged, with priority to the inner `postcssOptions`
    if (postcssOptions.preset) {
      postcssOptions.postcssOptions.preset = {
        ...postcssOptions.preset || {} ,
        ...postcssOptions.postcssOptions.preset || {}
      }
      delete postcssOptions.preset
    }
    // The `postcssOptions.order` is used only if there is no `postcssOptions.postcssOptions.order`
    if (postcssOptions.order) {
      postcssOptions.postcssOptions.order = postcssOptions.postcssOptions.order || postcssOptions.order
      delete postcssOptions.order
    }
    return postcssOptions
  }

  sortPlugins ({ plugins, order }) {
    const names = Object.keys(plugins)
    if (typeof order === 'string') {
      order = orderPresets[order]
    }
    return typeof order === 'function' ? order(names, orderPresets) : (order || names)
  }

  loadPlugins (postcssOptions) {
    const { plugins } = postcssOptions
    if (isPureObject(plugins)) {
      // Map postcss plugins into instances on object mode once
      postcssOptions.plugins = this.sortPlugins(postcssOptions)
        .map((p) => {
          const plugin = this.buildContext.nuxt.resolver.requireModule(p, { paths: [__dirname] })
          const opts = plugins[p]
          if (opts === false) {
            return false // Disabled
          }
          return plugin(opts)
        })
        .filter(Boolean)
    }
  }

  config () {
    /* istanbul ignore if */
    if (!this.postcssOptions) {
      return false
    }

    const postcssOptionsFromFile = this.configFromFile()
    if (postcssOptionsFromFile) {
      return {
        postcssOptions: postcssOptionsFromFile,
        sourceMap: this.cssSourceMap
      }
    }

    const postcssOptions = this.normalize(cloneDeep(this.postcssLoaderOptions))

    // Apply default plugins
    if (isPureObject(postcssOptions)) {
      const postcssLoaderOptions = this.postcssLoaderOptions
      if (postcssLoaderOptions.plugins) {
        if (!postcssOptions.plugins || isPureObject(postcssOptions.plugins)) {
          postcssOptions.plugins = { ...postcssLoaderOptions.plugins || {}, ...postcssOptions.plugins || {} }
        }
        delete postcssLoaderOptions.plugins
      }
      if ('order' in postcssLoaderOptions) {
        // Prioritise correct config value
        postcssOptions.order = postcssOptions.order || postcssLoaderOptions.order
        delete postcssLoaderOptions.order
      }

      if (Array.isArray(postcssOptions.plugins)) {
        defaults(postcssOptions, this.defaultPostcssOptions)
      } else {
        if (postcssOptions.preset || postcssLoaderOptions.preset) {
          postcssOptions.plugins = {
            ...postcssOptions.plugins || {},
            'postcss-preset-env': merge({}, postcssOptions.preset || postcssLoaderOptions.preset)
          }
          delete postcssOptions.preset
        }

        // Keep the order of default plugins
        postcssOptions = merge({}, this.defaultPostcssOptions, postcssOptions)
        this.loadPlugins(postcssOptions)
      }

      delete postcssOptions.order
      delete postcssLoaderOptions.preset

      return {
        sourceMap: this.cssSourceMap,
        ...postcssLoaderOptions,
        postcssOptions
      }
    }
  }
}
