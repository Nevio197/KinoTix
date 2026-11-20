function enableSearchSuggestions(input, searchLocal, search, open) {
  const form = input.form
  const results = document.createElement('div')
  results.className = 'search-suggestions'
  results.hidden = true
  results.setAttribute('aria-label', 'Titelvorschläge')
  form.append(results)
  let generation = 0
  let timer
  function clear() {
    generation++
    clearTimeout(timer)
    results.hidden = true
    results.replaceChildren()
  }
  input.addEventListener('input', () => {
    clear()
    const term = input.value.trim()
    if (term.length < 2) return
    const current = generation
    timer = setTimeout(async () => {
      let complete=false
      const render=items=>{
        if (generation !== current || !form.contains(document.activeElement)) return
        if (results.contains(document.activeElement)) return
        results.replaceChildren()
        for (const item of items.slice(0, 5)) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = item.title
          button.addEventListener('click', () => { clear(); open(item) })
          results.append(button)
        }
        results.hidden = !results.childElementCount
      }
      void searchLocal(term).then(items=>{if (!complete && items.length) render(items)}).catch(()=>{})
      try { const items=await search(term);complete=true;render(items) }
      catch { /* The saved results stay usable while offline. */ }
    }, 280)
  })
  form.addEventListener('submit', clear)
  form.addEventListener('focusout', event => { if (!form.contains(event.relatedTarget)) clear() })
  form.addEventListener('keydown', event => {
    if (results.hidden) return
    const buttons = Array.from(results.children)
    const index = buttons.indexOf(document.activeElement)
    if (event.key === 'Escape') { clear(); input.focus() }
    else if (event.key === 'ArrowDown') buttons[Math.min(index + 1, buttons.length - 1)].focus()
    else if (event.key === 'ArrowUp') (buttons[index - 1] || input).focus()
    else return
    event.preventDefault()
  })
}
