
vue是一套用于构建用户界面的渐进式框架。当vue组件中数据变化是，界面会响应数据的变化，自动更新。这是vue工作的的基本流程。

在vue3中，负责数据响应式处理的模块是`reactivity`，此模块提供了在数据变化时，执行`ReactiveEffect`的能力。但是，如果只使用`reactivity`提供的能力，当数据频繁的变化，`ReactiveEffect`也会被频繁的执行，因此vue在另外的package中了另外的方法，使得`ReactiveEffect`的执行不是那么的频繁，这就是文章要分析的部分`scheduler`。

## `scheduler`提供了哪些能力

scheduler部分的源码在`packages/runtime-core/src/scheduler.ts`文件中，为外部提供了如下的api:
```js
// 从vue测试代码中摘抄
import {
  queueJob,
  nextTick,
  queuePostFlushCb,
  invalidateJob,
  queuePreFlushCb,
  flushPreFlushCbs,
  flushPostFlushCbs
} from '../src/scheduler'
```
那么，这些api时如何被使用的呢。下面列举两个例子。

### dom自动更新

> 本部分的源码位于`packages/runtime-core/src/renderer.ts`文件中

在vue组件被挂载到dom上的过程中，会执行`mountComponent`方法，在执行这个方法的过程中，会执行`setupRenderEffect`方法。

```js
    const setupRenderEffect = (instance, initialVNode, container, anchor, parentSuspense, isSVG, optimized) => {
        const componentUpdateFn = () => {
            if (!instance.isMounted) {
                // mountComponent
                // ...
            }
            else {
                // updateComponent
                ...
            }
        };
        // create reactive effect for rendering
        const effect = (instance.effect = new ReactiveEffect(componentUpdateFn, () => queueJob(instance.update), instance.scope // track it in component's effect scope
        ));
        const update = (instance.update = effect.run.bind(effect));
        update.id = instance.uid;
        // allowRecurse
        // #1801, #2043 component render effects should allow recursive updates
        toggleRecurse(instance, true);
        if (__DEV__) {
            effect.onTrack = instance.rtc
                ? e => invokeArrayFns(instance.rtc, e)
                : void 0;
            effect.onTrigger = instance.rtg
                ? e => invokeArrayFns(instance.rtg, e)
                : void 0;
            // @ts-ignore (for scheduler)
            update.ownerInstance = instance;
        }
        update();
    };
```

函数内部首先创建了一个函数`componentUpdateFn`，componentUpdateFn的作用时挂载及更新组件，不是我们关心的重点，所以这里并没有给出具体的代码。

我们关心的重点是`ReactiveEffect`的创建。在创建ReactiveEffect时，注意前两个实参，`componentUpdateFn`,`() => queueJob(instance.update)`，分别对应`ReactiveEffect`的形参`run`,`scheduler`。而在数据变化时，ReactiveEffect执行时，存在scheduler时执行scheduler，否则执行run。
```js
// 此部分代码位于packages/reactivity/src/effect.ts中
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  for (const effect of isArray(dep) ? dep : [...dep]) {
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      if (effect.scheduler) {
        effect.scheduler()
      } else {
        effect.run()
      }
    }
  }
}
```

因此当数据变化时，实际执行的时`() => queueJob(instance.update)`来更新组件，而`queueJob`则是`scheduler`提供的能力。

> instance.update实际就是组件更新的方法：componentUpdateFn

### watch API

在vue中，你可以这样使用watch api

```js
setup(){
  const count = ref(0)
  watch(count, ()=>{
    console.log('pre watch');
  },{
    flush: 'pre' 
  })
  watch(count, ()=>{
    console.log('post watch');
  },{
    flush: 'post' 
  })
  watch(count, ()=>{
    console.log('sync watch');
  },{
    flush: 'sync' 
  })
  function add(){
    count.value++
    count.value++
  }
  return ()=> {
    console.log('update')
    return (<div>
      <p>{count.value}</p>
      <button onClick={add}>点击加</button>
    </div>)
  }
}
```
当你点击按钮时，会得到下面的结果
```
sync watch
sync watch
pre watch
update
post watch
```

watch api的源码位于`packages/runtime-core/src/apiWatch.ts`。
```js
export function watch(source, cb, options) {
    if (__DEV__ && !isFunction(cb)) {
        warn(`\`watch(fn, options?)\` signature has been moved to a separate API. ` +
            `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
            `supports \`watch(source, cb, options?) signature.`);
    }
    return doWatch(source, cb, options);
}


function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ) {
    // 本部分不关心的...
    let scheduler;
    if (flush === 'sync') {
        scheduler = job; // the scheduler function gets called directly
    }
    else if (flush === 'post') {
        scheduler = () => queuePostRenderEffect(job, instance && instance.suspense);
    }
    else {
        // default: 'pre'
        scheduler = () => {
            if (!instance || instance.isMounted) {
                queuePreFlushCb(job);
            }
            else {
                // with 'pre' option, the first call must happen before
                // the component is mounted so it is called synchronously.
                job();
            }
        };
    }
    const effect = new ReactiveEffect(getter, scheduler);
    if (__DEV__) {
        effect.onTrack = onTrack;
        effect.onTrigger = onTrigger;
    }
    // initial run
    if (cb) {
        if (immediate) {
            job();
        }
        else {
            oldValue = effect.run();
        }
    }
    else if (flush === 'post') {
        queuePostRenderEffect(effect.run.bind(effect), instance && instance.suspense);
    }
    else {
        effect.run();
    }
    return () => {
        effect.stop();
        if (instance && instance.scope) {
            remove(instance.scope.effects, effect);
        }
    };
}
```
watch api是通过`dowatch`来实现的。

和组件挂载类似，过程中同样是创建了`ReactiveEffect`，`const effect = new ReactiveEffect(getter, scheduler)`，`getter`更新时，`scheduler`执行。而`scheduler`创建时则根据传入的配置而有所不同：
```js
export const queuePostRenderEffect = __FEATURE_SUSPENSE__
    ? queueEffectWithSuspense
    : queuePostFlushCb;

let scheduler;
if (flush === 'sync') {
    // 随着getter更新，马上执行，和直接使用reactivity模块没有什么区别
    scheduler = job; // the scheduler function gets called directly
}
else if (flush === 'post') {
    // 在组件更新后执行
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense);
}
else {
    // default: 'pre'
    scheduler = () => {
        if (!instance || instance.isMounted) {
            // 在组件更新前执行
            queuePreFlushCb(job);
        }
        else {
            // with 'pre' option, the first call must happen before
            // the component is mounted so it is called synchronously.
            job();
        }
    };
}

```
`queuePostFlushCb`,`queuePreFlushCb`同样是`scheduler`提供的能力。


## `scheduler`源码分析

scheduler部分的代码经过转译成`.js`后只有200多行，这里不会把所有的部分都涉及到，只会分析一些我认为主要的部分。

首先是一些全局的变量：

```js
// 执行flush任务
let isFlushing = false;
// 等待执行flush任务
let isFlushPending = false;

// 存放dom更新级任务
const queue = [];
let flushIndex = 0;

// 存放dom更新级前置任务
const pendingPreFlushCbs = [];
let activePreFlushCbs = null;
let preFlushIndex = 0;

// 存放dom更新级后置任务
const pendingPostFlushCbs = [];
let activePostFlushCbs = null;
let postFlushIndex = 0;


const resolvedPromise = Promise.resolve();
let currentFlushPromise = null;
```
scheduler中存在3个数组，用来存放等待`SchedulerJob`(`.ts`中的接口，表示等待执行的任务)。SchedulerJob被分成了3类：`pendingPreFlushCbs`存放dom更新级前置任务,`queue`存放dom更新级任务,`pendingPostFlushCbs`存放dom更新级后置任务。

`isFlushing`和`isFlushPending`是两个标志，会在后续说明，`currentFlushPromise`和`nextTick`api有关。


然后是在上一部分提到的3个api

```js
// 插入dom更新级任务
export function queueJob(job) {
    if ((!queue.length ||
        !queue.includes(job, isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex)) &&
        job !== currentPreFlushParentJob) {
        if (job.id == null) {
            queue.push(job);
        }
        else {
            queue.splice(findInsertionIndex(job.id), 0, job);
        }
        // 开启异步任务flush
        queueFlush();
    }
}

// 插入dom更新级前置任务
export function queuePreFlushCb(cb) {
    queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex);
}
// 插入入dom更新级后置任务
export function queuePostFlushCb(cb) {
    queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex);
}


function queueCb(cb, activeQueue, pendingQueue, index) {
    // activeQueue
    // 当执行任务池时，已有任务会赋值给activeQueue
    // 当activeQueue为null或activeQueue不存在此任务时，加入到任务池中
    if (!isArray(cb)) {
        if (!activeQueue ||
            !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)) {
            pendingQueue.push(cb);
        }
    }
    else {
        // if cb is an array, it is a component lifecycle hook which can only be
        // triggered by a job, which is already deduped in the main queue, so
        // we can skip duplicate check here to improve perf
        // 如果 cb 是一个数组，它是一个组件生命周期挂钩，只能由作业触发，
        // 该作业已经在主队列中进行了重复数据删除，因此我们可以在此处跳过重复检查以提高性能
        pendingQueue.push(...cb);
    }
    // 开启异步任务flush
    queueFlush();
}

```
`queueJob`,`queuePreFlushCb`,`queuePostFlushCb`过程中存在一些逻辑判断，这些内容是与vue运行时强相关的内容，不是关注的重点，这里略过。

可以发现，3个函数最终都会调用`queueFlush`方法。

```js
function queueFlush() {
    if (!isFlushing && !isFlushPending) {
        isFlushPending = true;
        currentFlushPromise = resolvedPromise.then(flushJobs);
    }
}
```
在这个方法中，首先判断isFlushing和isFlushPending是否未全为false，只有当全为false时，通过`Promise.resolve`启动微任务，执行SchedulerJob的任务队列。

当启动微任务刷新队列的时候，会将`isFlushPending = true`，表示开始等待刷新。当同步代码执行结束后，会执行相应的微任务队列，这时就会调用`flushJobs`函数。开始刷新队列。

> Vue 的响应性系统会缓存副作用函数，并异步地刷新它们，这样可以避免同一个“tick” 中多个状态改变导致的不必要的重复调用。

当isFlushing和isFlushPending任意一个不为false时，需要进入队列的任务仍然可以通过上面所提供的api来进入队列(缓存副作用函数)，但异步的任务是不会创建的。保证了在一个tick中，只会创建一次的异步任务。(避免同一个“tick” 中多个状态改变导致的不必要的重复调用)


```js
const getId = (job) => job.id == null ? Infinity : job.id;
// 执行任务
function flushJobs(seen) {
    // 此阶段是执行flush任务，更新标志
    isFlushPending = false;
    isFlushing = true;
    if (__DEV__) {
        seen = seen || new Map();
    }
    flushPreFlushCbs(seen);
    // Sort queue before flush.
    // 刷新前排序队列
    // This ensures that:
    // 这确保了
    // 1. Components are updated from parent to child. (because parent is always
    //    created before the child so its render effect will have smaller
    //    priority number)
    // 组件从父级更新到子级。 （因为 parent 总是在 child 之前创建，所以它的渲染效果将具有较小的优先级数）
    // 2. If a component is unmounted during a parent component's update,
    //    its update can be skipped.
    // 如果在父组件更新期间卸载组件，则可以跳过其更新。
    queue.sort((a, b) => getId(a) - getId(b));
    // conditional usage of checkRecursiveUpdate must be determined out of
    // try ... catch block since Rollup by default de-optimizes treeshaking
    // inside try-catch. This can leave all warning code unshaked. Although
    // they would get eventually shaken by a minifier like terser, some minifiers
    // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
    // checkRecursiveUpdate 的条件使用必须在 try ... catch 块之外确定，因为 Rollup 默认取消优化 try-catch 内的 treeshaking。这可以使所有警告代码保持不变。尽管它们最终会被像 terser 这样的缩小器所动摇，但一些缩小器无法做到这一点（例如 https://github.com/evanw/esbuild/issues/1610）
    const check = __DEV__
        ? (job) => checkRecursiveUpdates(seen, job)
        : NOOP;
    try {
    // 执行dom更新级任务
        for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
            const job = queue[flushIndex];
            if (job && job.active !== false) {
                if (__DEV__ && check(job)) {
                    continue;
                }
                // console.log(`running:`, job.id)
                callWithErrorHandling(job, null, 14 /* SCHEDULER */);
            }
        }
    }
    finally {
        flushIndex = 0;
        queue.length = 0;
        // // 执行dom更新级后置任务
        flushPostFlushCbs(seen);
        isFlushing = false;
        currentFlushPromise = null;
        // some postFlushCb queued jobs!
        // keep flushing until it drains.
        if (queue.length ||
            pendingPreFlushCbs.length ||
            pendingPostFlushCbs.length) {
            // 存在递归执行
            flushJobs(seen);
        }
    }
}
```
`flushJobs`是SchedulerJob执行的入口，首先执行dom更新级前置前置任务

```js
// 执行之dom更新级前置任务
export function flushPreFlushCbs(seen, parentJob = null) {
    if (pendingPreFlushCbs.length) {
        currentPreFlushParentJob = parentJob;
        // 去重
        activePreFlushCbs = [...new Set(pendingPreFlushCbs)];
        pendingPreFlushCbs.length = 0;
        if (__DEV__) {
            seen = seen || new Map();
        }
        for (preFlushIndex = 0; preFlushIndex < activePreFlushCbs.length; preFlushIndex++) {
            if (__DEV__ &&
                checkRecursiveUpdates(seen, activePreFlushCbs[preFlushIndex])) {
                continue;
            }
            activePreFlushCbs[preFlushIndex]();
        }
        activePreFlushCbs = null;
        preFlushIndex = 0;
        currentPreFlushParentJob = null;
        // recursively flush until it drains
        // 递归冲洗直到耗尽
        flushPreFlushCbs(seen, parentJob);
    }
}

```
1. 去重
2. `activePreFlushCbs`接受需要执行的任务
3. 将`pendingPreFlushCbs`清空，防止后续重复执行
4. 遍历执行所有的`activePreFlushCbs`中的任务，并检查递归更新，防止无限递归
5. 在SchedulerJob执行的过程中，又可能创建新的SchedulerJob，所以需要递归执行前置任务


当`flushPreFlushCbs`函数执行结束后，就会进行dom更新级任务的执行。这时存在于`queue`函数就会执行（`instance.update`组件更新）。但是在执行`queue`中的任务的时候，需要对任务去重排序，这些工作完成之后，才会遍历执行`queue`中的任务。

1. 排序，保重更新顺序是父组件 -> 子组件
2. 遍历更新
3. 检查是否unmount，如果卸载，在不执行

然后执行后置任务

```js
// 执行之后置任务
export function flushPostFlushCbs(seen) {
    if (pendingPostFlushCbs.length) {
        const deduped = [...new Set(pendingPostFlushCbs)];
        pendingPostFlushCbs.length = 0;
        // #1947 already has active queue, nested flushPostFlushCbs call
        if (activePostFlushCbs) {
            activePostFlushCbs.push(...deduped);
            return;
        }
        activePostFlushCbs = deduped;
        if (__DEV__) {
            seen = seen || new Map();
        }
        activePostFlushCbs.sort((a, b) => getId(a) - getId(b));
        for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
            if (__DEV__ &&
                checkRecursiveUpdates(seen, activePostFlushCbs[postFlushIndex])) {
                continue;
            }
            activePostFlushCbs[postFlushIndex]();
        }
        activePostFlushCbs = null;
        postFlushIndex = 0;
    }
}
```

和执行前置任务类似，但没有递归执行步骤。

最后，如果3个任务池中还有未执行的任务，递归执行`flushJobs`，保证所所有任务在同一个`tick`中完成。全部执行完毕后，会将`isFlushing`置为false,确保下一次`flushJobs`可以执行。

## nextTick

从上述分析中可以看出，vue中存在3个任务池，组件更新被放在`queue`中，开发者可以通过`watch`等api选择将任务插入到另外2个任务池中。

nextTick的描述如下：

> 将回调推迟到下一个 DOM 更新周期之后执行。在更改了一些数据以等待 DOM 更新后立即使用它。


```js
export function nextTick(fn) {
    const p = currentFlushPromise || resolvedPromise;
    return fn ? p.then(this ? fn.bind(this) : fn) : p;
}
```
nextTick建议在更改数据后使用。在数据更改后，`queueFlush`会被调用，这时nextTick返回Promise，`const p = currentFlushPromise || resolvedPromise;`会与`queueFlush`中的`currentFlushPromise = resolvedPromise.then(flushJobs)`中的Promise指向同一个。

当Promise被解决后，也即3个任务池中的任务全部执行完毕后，nextTick中的fn才会被执行，即将回调推迟到下一个 DOM 更新周期之后执行。

> 即便在数据更改前，调用了`nextTick`，因为组件挂载是同步的，fn仍然是在组件挂载后执行的。



![vue-scheduler.png](https://p6-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/dafee1fa3b2b40c5a5bfaf11e1d557dd~tplv-k3u1fbpfcp-watermark.image?)