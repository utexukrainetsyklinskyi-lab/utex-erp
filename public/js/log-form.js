const downtimeToggle = document.querySelector('#has_downtime');
const deviationToggle = document.querySelector('#has_deviation');

function setVisibility(toggle, selector) {
  if (!toggle) return;
  const update = () => document.querySelectorAll(selector).forEach(field => { field.hidden = !toggle.checked; });
  toggle.addEventListener('change', update);
  update();
}

setVisibility(downtimeToggle, '[data-downtime-field]');
setVisibility(deviationToggle, '[data-deviation-field]');
