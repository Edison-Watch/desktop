/**
 * Shared inline JavaScript for the credential review panel used in both
 * quarantine and registration dialogs.
 *
 * Exported as a template string that gets injected into the inline <script>
 * block of each dialog. Depends on these being defined by the caller script:
 *   - `activePopup` (let, initially null)
 *   - `findItemByFingerprint(fingerprint)`
 *   - `reenableButtons()`
 *   - `showAlreadyPendingBadge(fingerprint)`
 *   - `showStatusBadge(fingerprint, msg, isError)` (quarantine only)
 *   - `removeServerItem(fingerprint)`
 *   - `serverConfigs`
 *   - `results`
 */

export const CREDENTIAL_REVIEW_JS = `
          // ── Credential review helpers ──────────────────────────────

          function getConfigEntries(config) {
            const entries = []
            if (config.command) {
              entries.push({ context: 'command', key: 'command', rawValue: String(config.command), entryId: 'command:command' })
            }
            if (Array.isArray(config.args)) {
              config.args.forEach((arg, i) => {
                entries.push({ context: 'args', key: 'arg[' + i + ']', rawValue: String(arg), entryId: 'args:arg[' + i + ']' })
              })
            }
            if (config.env && typeof config.env === 'object') {
              Object.entries(config.env).forEach(([k, v]) => {
                entries.push({ context: 'env', key: k, rawValue: String(v), entryId: 'env:' + k })
              })
            }
            if (config.url) {
              entries.push({ context: 'url', key: 'url', rawValue: String(config.url), entryId: 'url:url' })
            }
            if (config.headers && typeof config.headers === 'object') {
              Object.entries(config.headers).forEach(([k, v]) => {
                entries.push({ context: 'headers', key: k, rawValue: String(v), entryId: 'headers:' + k })
              })
            }
            return entries
          }

          function findSecretInValue(raw, secretValues, templatizedValue) {
            for (const [varName, secretVal] of Object.entries(secretValues)) {
              const placeholder = '{' + varName + '}'
              if (templatizedValue.includes(placeholder) && raw.includes(secretVal)) {
                const start = raw.indexOf(secretVal)
                return { varName, start, end: start + secretVal.length, text: secretVal }
              }
            }
            return null
          }

          function getTemplatizedValue(entry, templatizedConfig) {
            if (entry.context === 'args') {
              const idx = parseInt((entry.key.match(/\\\\d+/) || ['0'])[0], 10)
              const tArgs = templatizedConfig.args
              return (tArgs && tArgs[idx]) ? String(tArgs[idx]) : entry.rawValue
            }
            if (entry.context === 'env') {
              const tEnv = templatizedConfig.env
              return (tEnv && tEnv[entry.key]) ? String(tEnv[entry.key]) : entry.rawValue
            }
            if (entry.context === 'url') {
              return templatizedConfig.url ? String(templatizedConfig.url) : entry.rawValue
            }
            if (entry.context === 'headers') {
              const tHeaders = templatizedConfig.headers
              return (tHeaders && tHeaders[entry.key]) ? String(tHeaders[entry.key]) : entry.rawValue
            }
            return entry.rawValue
          }

          function generateTokenName(markings) {
            const used = new Set()
            for (const m of Object.values(markings)) {
              const match = m.varName.match(/^TOKEN_(\\\\d+)$/)
              if (match) used.add(Number(match[1]))
            }
            let n = 1
            while (used.has(n)) n++
            return 'TOKEN_' + n
          }

          function dismissPopup() {
            if (activePopup) { activePopup.remove(); activePopup = null }
            window.getSelection()?.removeAllRanges()
          }

          document.addEventListener('mousedown', (e) => {
            if (activePopup && !activePopup.contains(e.target)) dismissPopup()
          })

          function renderValueSpan(entry, marking) {
            const span = document.createElement('span')
            span.className = 'cr-value'
            span.dataset.entryId = entry.entryId
            span.dataset.context = entry.context
            if (entry.context !== 'command') {
              span.setAttribute('data-value-container', '')
            }
            updateValueSpan(span, entry, marking)
            return span
          }

          function updateValueSpan(span, entry, marking) {
            span.innerHTML = ''
            if (!marking) {
              span.textContent = entry.rawValue
              return
            }
            if (marking.start > 0) {
              const pre = document.createElement('span')
              pre.textContent = entry.rawValue.slice(0, marking.start)
              span.appendChild(pre)
            }
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'cr-secret-btn' + (marking.enabled ? '' : ' disabled')
            btn.textContent = marking.selectedText
            btn.title = marking.enabled ? 'Click to disable (keep value as-is)' : 'Click to re-enable as secret'
            span.appendChild(btn)
            if (marking.end < entry.rawValue.length) {
              const suf = document.createElement('span')
              suf.textContent = entry.rawValue.slice(marking.end)
              span.appendChild(suf)
            }
            if (marking.enabled) {
              const lbl = document.createElement('span')
              lbl.className = 'cr-var-label'
              lbl.textContent = '{' + marking.varName + '}'
              span.appendChild(lbl)
            }
          }

          function buildCredentialReviewPanel(fingerprint, serverName, sourceApp, action, analysis, callbacks) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) return

            const config = analysis.config
            const templatizedConfig = analysis.templatizedConfig
            const secretValues = analysis.secretValues || {}
            const entries = getConfigEntries(config)

            const markings = {}
            for (const entry of entries) {
              const tv = getTemplatizedValue(entry, templatizedConfig)
              const found = findSecretInValue(entry.rawValue, secretValues, tv)
              if (found) {
                markings[entry.entryId] = {
                  varName: found.varName,
                  selectedText: found.text,
                  start: found.start,
                  end: found.end,
                  enabled: true
                }
              }
            }

            const actionsEl = item.querySelector('.server-actions')
            const badgeEl = item.querySelector('.quarantine-badge')
            if (actionsEl) actionsEl.style.display = 'none'
            if (badgeEl) badgeEl.style.display = 'none'

            const panel = document.createElement('div')
            panel.className = 'credential-review'

            const enabledCount = Object.values(markings).filter(m => m.enabled).length
            const desc = document.createElement('div')
            desc.className = 'cr-description'
            desc.textContent = enabledCount > 0
              ? enabledCount + ' credential' + (enabledCount === 1 ? '' : 's') + ' detected. Review and adjust before submitting. These credentials will be encrypted.'
              : 'No credentials auto-detected. Select text in any value to mark it as a secret.'
            panel.appendChild(desc)

            if (entries.length > 0) {
              const hint = document.createElement('div')
              hint.className = 'cr-hint'
              hint.textContent = 'Select any part of a value to mark it as a credential. Only one credential per line.'
              panel.appendChild(hint)
            }

            const entriesDiv = document.createElement('div')
            entriesDiv.className = 'cr-entries'

            if (entries.length === 0) {
              const empty = document.createElement('div')
              empty.className = 'cr-empty'
              empty.textContent = 'No configurable values found for this server.'
              entriesDiv.appendChild(empty)
            } else {
              for (const entry of entries) {
                const row = document.createElement('div')
                row.className = 'cr-entry'

                const label = document.createElement('span')
                label.className = 'cr-label'
                label.textContent = entry.context === 'command' ? '$' : entry.key + (entry.context !== 'args' ? '=' : '')
                row.appendChild(label)

                const valueSpan = renderValueSpan(entry, markings[entry.entryId])
                row.appendChild(valueSpan)

                valueSpan.addEventListener('click', (e) => {
                  const secretBtn = e.target.closest('.cr-secret-btn')
                  if (!secretBtn) return
                  const m = markings[entry.entryId]
                  if (!m) return
                  m.enabled = !m.enabled
                  updateValueSpan(valueSpan, entry, m)
                  updateDescription()
                })

                if (entry.context !== 'command') {
                  valueSpan.addEventListener('mouseup', (e) => {
                    setTimeout(() => {
                      const sel = window.getSelection()
                      if (!sel || sel.isCollapsed || !sel.rangeCount) return
                      const text = sel.toString().trim()
                      if (!text || !entry.rawValue.includes(text)) return

                      const range = sel.getRangeAt(0)
                      const container = range.startContainer.parentElement?.closest('[data-value-container]')
                      if (!container) return
                      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
                      let charCount = 0, startOffset = -1, node
                      while ((node = walker.nextNode())) {
                        if (node === range.startContainer) { startOffset = charCount + range.startOffset; break }
                        charCount += (node.textContent || '').length
                      }
                      if (startOffset < 0) return
                      const endOffset = startOffset + text.length

                      dismissPopup()
                      const popup = document.createElement('div')
                      popup.className = 'cr-popup'
                      popup.style.left = e.clientX + 'px'
                      popup.style.top = (e.clientY + 8) + 'px'

                      const markBtn = document.createElement('button')
                      markBtn.type = 'button'
                      markBtn.className = 'cr-popup-mark'
                      markBtn.textContent = 'Mark as secret'
                      markBtn.addEventListener('click', () => {
                        const varName = generateTokenName(markings)
                        markings[entry.entryId] = { varName, selectedText: text, start: startOffset, end: endOffset, enabled: true }
                        updateValueSpan(valueSpan, entry, markings[entry.entryId])
                        updateDescription()
                        dismissPopup()
                      })
                      popup.appendChild(markBtn)

                      const closeBtn = document.createElement('button')
                      closeBtn.type = 'button'
                      closeBtn.className = 'cr-popup-close'
                      closeBtn.innerHTML = '<svg viewBox="0 0 10 10" width="12" height="12"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
                      closeBtn.addEventListener('click', () => dismissPopup())
                      popup.appendChild(closeBtn)

                      document.body.appendChild(popup)
                      activePopup = popup
                    }, 0)
                  })
                }

                entriesDiv.appendChild(row)
              }
            }
            panel.appendChild(entriesDiv)

            function updateDescription() {
              const count = Object.values(markings).filter(m => m.enabled).length
              desc.textContent = count > 0
                ? count + ' credential' + (count === 1 ? '' : 's') + ' detected. Review and adjust before submitting. These credentials will be encrypted.'
                : 'No credentials marked. Select text in any value to mark it as a secret.'
            }

            const actionsRow = document.createElement('div')
            actionsRow.className = 'cr-actions'

            const backBtn = document.createElement('button')
            backBtn.type = 'button'
            backBtn.className = 'button button-dismiss'
            backBtn.textContent = 'Back'
            backBtn.addEventListener('click', () => {
              dismissPopup()
              panel.remove()
              if (actionsEl) actionsEl.style.display = ''
              if (badgeEl) badgeEl.style.display = ''
              reenableButtons()
            })
            actionsRow.appendChild(backBtn)

            const confirmBtn = document.createElement('button')
            confirmBtn.type = 'button'
            confirmBtn.className = 'button button-request'
            confirmBtn.textContent = 'Confirm & Submit'
            confirmBtn.addEventListener('click', async () => {
              confirmBtn.disabled = true
              confirmBtn.style.opacity = '0.5'
              backBtn.disabled = true
              backBtn.style.opacity = '0.5'
              dismissPopup()

              const overrides = []
              for (const [entryId, m] of Object.entries(markings)) {
                if (m.enabled) {
                  overrides.push({ entryId, varName: m.varName, selectedText: m.selectedText, start: m.start, end: m.end })
                }
              }

              callbacks.onConfirm(fingerprint, serverName, sourceApp, action, overrides)
            })
            actionsRow.appendChild(confirmBtn)

            panel.appendChild(actionsRow)
            item.appendChild(panel)
          }
`
