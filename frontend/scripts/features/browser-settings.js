/**
 * 浏览器设置页面
 * 管理浏览器导入登录的 Cookie，支持清除、查看和追加导入
 */
(function () {
  function showToast(msg, type) {
    if (window.ToastUI?.show) window.ToastUI.show(msg, type || 'info')
  }

  async function loadBrowserImportStatus() {
    const statusEl = document.getElementById('browserImportStatus')
    if (!statusEl) return
    try {
      // 检查当前导入的 Cookie 数量
      const result = await window.api?.listBrowserProfiles?.()
      const browsers = result?.browsers || []
      if (browsers.length) {
        const names = browsers.map(b => b.displayName || b.browserId).join('、')
        statusEl.textContent = `已发现 ${browsers.length} 个浏览器：${names}`
        statusEl.style.color = 'var(--color-success, #34d399)'
      } else {
        statusEl.textContent = '未发现可用的浏览器，请安装 Chrome、Edge、QQ浏览器或夸克浏览器。'
        statusEl.style.color = 'var(--color-warning, #fbbf24)'
      }
    } catch (e) {
      statusEl.textContent = '检查失败：' + (e.message || e)
      statusEl.style.color = 'var(--color-error, #f87171)'
    }
  }

  async function importCookies(mode) {
    const browsers = await window.api?.listBrowserProfiles?.()
    const browserList = browsers?.browsers || []
    if (!browserList.length) {
      showToast('未发现可用的浏览器', 'error')
      return
    }
    // 选择浏览器
    const choice = await pickBrowserProfile(browserList)
    if (!choice) return

    const modeText = mode === 'append' ? '追加导入' : '覆盖导入'
    showToast(`正在${modeText}：${choice.displayName}（${choice.profileLabel}）...`, 'info')

    try {
      const result = await window.api.importGoogleCookiesFromChrome({
        browserId: choice.browserId,
        profileName: choice.profileName,
        importMode: mode // 'append' 或 'overwrite'
      })
      if (result?.success) {
        showToast(`${modeText}成功：${result.imported} 条 Cookie`, 'success')
        // 刷新当前页面
        const webviews = document.querySelectorAll('webview')
        webviews.forEach(wv => { try { wv.reload?.() } catch (_) {} })
      } else {
        showToast(`${modeText}失败：${result?.error || '未知错误'}`, 'error')
      }
    } catch (e) {
      showToast(`${modeText}失败：${e.message}`, 'error')
    }
  }

  async function pickBrowserProfile(browsers) {
    return window.LingxiDialog.show({
      variant: 'list-picker',
      title: '选择浏览器',
      message: '选择要导入 Cookie 的浏览器',
      items: (browsers || []).map(b => ({
        label: b.displayName || b.browserId,
        sublabel: b.profiles?.[0]?.label || 'Default',
        value: {
          browserId: b.browserId,
          displayName: b.displayName || b.browserId,
          profileName: b.profiles?.[0]?.profileName || 'Default',
          profileLabel: b.profiles?.[0]?.label || 'Default'
        }
      }))
    })
  }

  function bind() {
    // 追加导入
    const appendBtn = document.getElementById('browserImportAppendBtn')
    if (appendBtn) {
      appendBtn.addEventListener('click', () => importCookies('append'))
    }

    // 覆盖导入
    const overwriteBtn = document.getElementById('browserImportOverwriteBtn')
    if (overwriteBtn) {
      overwriteBtn.addEventListener('click', () => importCookies('overwrite'))
    }

    // 清除导入的 Cookie
    const clearCookiesBtn = document.getElementById('browserClearCookiesBtn')
    if (clearCookiesBtn) {
      clearCookiesBtn.addEventListener('click', async () => {
        const confirmed = await window.LingxiDangerDialog.show({
          title: '清除浏览器 Cookie',
          targetName: '所有导入的 Cookie',
          targetLabel: '清除范围',
          subtitle: '将删除右侧浏览器中导入的登录状态和站点 Cookie。',
          tags: ['登录状态', '站点 Cookie'],
          note: '不会影响灵犀自身设置，清除后部分网站需要重新登录。',
          confirmText: '确认清除'
        })
        if (!confirmed) return
        try {
          const result = await window.api.clearBrowserImportStorage?.()
          if (result?.success) {
            showToast('已清除导入的 Cookie', 'success')
            // 刷新当前页面
            const webviews = document.querySelectorAll('webview')
            webviews.forEach(wv => { try { wv.reload?.() } catch (_) {} })
          } else {
            showToast('清除失败：' + (result?.error || '未知错误'), 'error')
          }
        } catch (e) {
          showToast('清除失败：' + e.message, 'error')
        }
      })
    }

    // 清除存储配额
    const clearStorageBtn = document.getElementById('browserClearStorageBtn')
    if (clearStorageBtn) {
      clearStorageBtn.addEventListener('click', async () => {
        const confirmed = await window.LingxiDangerDialog.show({
          title: '清除浏览器存储',
          targetName: '浏览器导入的存储数据',
          targetLabel: '清除范围',
          subtitle: '将清除导入到右侧浏览器中的站点存储数据。',
          tags: ['本地存储', '站点缓存', 'Cookie'],
          note: '该操作可释放存储配额，但可能导致网站退出登录。',
          confirmText: '确认清除'
        })
        if (!confirmed) return
        try {
          const result = await window.api.clearBrowserImportStorage?.()
          if (result?.success) {
            showToast('已清除存储配额', 'success')
          } else {
            showToast('清除失败：' + (result?.error || '未知错误'), 'error')
          }
        } catch (e) {
          showToast('清除失败：' + e.message, 'error')
        }
      })
    }

    // 加载状态
    loadBrowserImportStatus()
  }

  // 当设置页面切换到浏览器设置时初始化
  function init() {
    const tab = document.getElementById('settingsTabBrowserSettings')
    if (tab) {
      tab.addEventListener('click', () => {
        setTimeout(loadBrowserImportStatus, 100)
      })
    }
    bind()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  window.BrowserSettingsPage = { loadBrowserImportStatus, importCookies }
})()
