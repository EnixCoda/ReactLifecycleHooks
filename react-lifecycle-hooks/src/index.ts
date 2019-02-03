import compareVersions = require('compare-versions')
import * as React from 'react'

let theReact: typeof React
try {
  theReact = require('react')
} catch (e) {}

const middlewares: Middleware[] = []

type lifecycleName =
  | 'render'
  | keyof React.ComponentLifecycle<any, any, any>
  | keyof React.StaticLifecycle<any, any>

type ComponentClass = React.ComponentClass | React.SFC

function applyMiddlewares(heartbeat: HeartBeat) {
  middlewares.forEach(middleware => {
    middleware(heartbeat)
  })
}

type Task = (returnValue: any) => any

interface HeartBeat {
  componentClass: ComponentClass
  componentInstance: React.ReactInstance | React.StatelessComponent
  lifecycleName: lifecycleName
  lifecycleArguments: any[]
  returnAs: (task: Task) => void
}

interface Middleware {
  (heartbeat: HeartBeat): void
}

interface RemoveMiddleware extends Function {}

export function addMiddleware(middleware: Middleware): RemoveMiddleware {
  const uniqueMiddleware = middleware.bind(null)
  middlewares.push(uniqueMiddleware)
  return function removeMiddleware() {
    let index = middlewares.indexOf(uniqueMiddleware)
    if (index !== -1) middlewares.splice(index, 1)
  }
}

function wrapLifecycleMethod(
  componentClass: ComponentClass,
  method: Function | undefined,
  lifecycleName: lifecycleName
) {
  return function(...lifecycleArguments: any[]) {
    const componentInstance = this
    let shouldNotAddTaskAnymore = false
    const tasks: Task[] = []
    const returnAs = (task: Task) => {
      if (shouldNotAddTaskAnymore) {
        console.warn('Please do not call returnAs in returnAs, aborting...')
        return
      }
      tasks.push(task)
    }
    applyMiddlewares({
      componentClass,
      componentInstance,
      lifecycleName,
      lifecycleArguments,
      returnAs,
    })
    const returnValue = method ? method.apply(componentInstance, lifecycleArguments) : undefined
    shouldNotAddTaskAnymore = true
    return tasks.reduce((prevReturn, task) => task(prevReturn), returnValue)
  }
}

type lifecycleSlot =
  | {
      name: lifecycleName
      default?: Function
    }
  | lifecycleName

let instanceLifecycles: lifecycleSlot[] = []
let instancePureLifecycles: lifecycleSlot[] = []
let staticLifecycles: lifecycleSlot[] = []

const lifecycles: {
  [key: string]: {
    [key: string]: lifecycleSlot[]
  }
} = {
  instance: {
    common: [
      { name: 'componentDidMount' },
      { name: 'render' },
      { name: 'componentDidUpdate' },
      { name: 'componentWillUnmount' },
      { name: 'componentDidCatch' },
    ],
    pure: [
      {
        name: 'shouldComponentUpdate',
        default: function shouldComponentUpdate() {
          return true
        },
      },
    ],
    legacy: [
      { name: 'componentWillMount' },
      { name: 'componentWillReceiveProps' },
      { name: 'componentWillUpdate' },
    ],
    latest: [
      {
        name: 'getSnapshotBeforeUpdate',
        default: function getSnapshotBeforeUpdate(): null {
          return null
        },
      },
    ],
  },
  statics: {
    common: [],
    legacy: [],
    latest: [
      {
        name: 'getDerivedStateFromProps',
        default: function getDerivedStateFromProps(): null {
          return null
        },
      },
    ],
  },
}

type Compat = 'legacy' | 'latest' | 'all'

function handleCompat(compat: Compat) {
  const { instance, statics } = lifecycles
  switch (compat) {
    case 'legacy':
      instancePureLifecycles = [...instance.common, ...instance.legacy]
      instanceLifecycles = [...instancePureLifecycles, ...instance.pure]
      staticLifecycles = [...statics.common, ...statics.legacy]
      return
    case 'latest':
      instancePureLifecycles = [...instance.common, ...instance.latest]
      instanceLifecycles = [...instancePureLifecycles, ...instance.pure]
      staticLifecycles = [...statics.common, ...statics.latest]
      return
    case 'all':
      instancePureLifecycles = [...instance.common, ...instance.legacy, ...instance.latest]
      instanceLifecycles = [...instancePureLifecycles, ...instance.pure]
      staticLifecycles = [...statics.common, ...statics.legacy, ...statics.latest]
      return
    default:
      if (compareVersions(theReact.version, '16.0.0') < 0) {
        handleCompat('legacy')
      } else {
        handleCompat('latest')
      }
  }
}

interface Options {
  compat?: Compat
  React?: typeof React
}

function applyOptions(options: Options) {
  handleCompat(options.compat)
}

function noop() {}

const decorationMap = new Map()

function decorate(componentType: ComponentClass) {
  if (
    !(componentType.prototype instanceof theReact.Component) &&
    !(componentType as any).isReactTopLevelWrapper // for React v15
  ) {
    const render = componentType as React.SFC
    const decorated = wrapLifecycleMethod(componentType, render, 'render') as React.SFC
    decorated.displayName = componentType.displayName || componentType.name
    return decorated
  }
  const componentClass = componentType as React.ComponentClass
  class DecoratedClass extends componentClass {
    static displayName = componentClass.displayName || componentClass.name
  }

  const isPureComponentClass = componentType.prototype instanceof theReact.PureComponent
  const lifecyclesForTheClass = isPureComponentClass ? instancePureLifecycles : instanceLifecycles

  lifecyclesForTheClass.forEach(lifecycle => {
    const lifecycleName = typeof lifecycle === 'string' ? lifecycle : lifecycle.name
    const method = componentClass.prototype[lifecycleName] as Function | undefined
    ;(DecoratedClass.prototype as any)[lifecycleName] = wrapLifecycleMethod(
      componentClass,
      typeof method === 'function'
        ? method
        : typeof lifecycle === 'string'
        ? undefined
        : lifecycle.default,
      lifecycleName
    )
  })

  // Seems somehow redundant to above :(
  staticLifecycles.forEach(lifecycle => {
    const lifecycleName = typeof lifecycle === 'string' ? lifecycle : lifecycle.name
    const method = (componentClass as any)[lifecycleName] as Function | undefined
    ;(DecoratedClass as any)[lifecycleName] = wrapLifecycleMethod(
      componentClass,
      typeof method === 'function'
        ? method
        : typeof lifecycle === 'string'
        ? undefined
        : lifecycle.default,
      lifecycleName
    )
  })
  return DecoratedClass
}

interface Deactivate extends Function {}

export function activate(options: Options = {}): Deactivate {
  if (options && options.React) {
    theReact = options.React
  } else {
    if (!theReact) {
      console.warn('React is not available, activation aborted!')
      return
    }
  }

  const react = theReact

  applyOptions(options)

  const { createElement } = react
  function _createElement(type: string | ComponentClass) {
    if (typeof type !== 'function') return createElement.apply(this, arguments)
    const componentClass = type
    if (!decorationMap.has(componentClass)) {
      decorationMap.set(componentClass, decorate(componentClass))
    }
    const decorated = decorationMap.get(componentClass)
    return createElement.apply(this, [decorated].concat(Array.prototype.slice.call(arguments, 1)))
  }
  react.createElement = _createElement
  return function deactivate() {
    if (react.createElement === _createElement) {
      react.createElement = createElement
    }
  }
}

export default {
  activate,
  addMiddleware,
}
