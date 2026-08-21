//
// Progressive-enhancement charts for the station page. Reads the JSON embedded
// in #chart-data and draws one accessible SVG line chart per pollutant (small
// multiples) or a single combined chart. Requires the global `d3` (vendored).
// Every chart also has a server-rendered data-table fallback, so this script is
// purely additive.
//
;(function () {
  'use strict'

  var d3 = window.d3
  var dataEl = document.getElementById('chart-data')
  if (!d3 || !dataEl) {
    return
  }

  var chartData
  try {
    chartData = JSON.parse(dataEl.textContent)
  } catch (error) {
    return
  }

  var pollutants = chartData?.pollutants || []
  var resolution = chartData?.resolution || 'hourly'
  var unit = chartData?.unit || 'µg/m³'

  var HEIGHT = 260
  var MARGIN = { top: 12, right: 18, bottom: 30, left: 44 }
  var MAX_FOCUSABLE = 24
  var DASH = {
    solid: null,
    dashed: '6,4',
    dotted: '1,4',
    'dash-dot': '10,4,2,4'
  }

  var fmtDay = d3.utcFormat('%e %b')
  var fmtHour = d3.utcFormat('%H:%M')
  var fmtFull = d3.utcFormat('%e %b %Y, %H:%M')

  function axisLabel(date) {
    return resolution === 'daily' ? fmtDay(date) : fmtHour(date)
  }
  function fullLabel(date) {
    return resolution === 'daily'
      ? fmtDay(date) + ' ' + d3.utcFormat('%Y')(date)
      : fmtFull(date)
  }

  var tooltip = document.createElement('div')
  tooltip.className = 'app-chart__tooltip'
  tooltip.setAttribute('role', 'status')
  tooltip.hidden = true
  document.body.appendChild(tooltip)

  function showTooltip(html, pageX, pageY) {
    tooltip.innerHTML = html
    tooltip.hidden = false
    tooltip.style.left = pageX + 'px'
    tooltip.style.top = pageY + 'px'
  }
  function hideTooltip() {
    tooltip.hidden = true
  }

  function parseSeries(series) {
    return (series || [])
      .map(function (point) {
        return { time: new Date(point.time), value: point.value }
      })
      .filter(function (point) {
        return !Number.isNaN(point.time.getTime()) && point.value != null
      })
  }

  function drawChart(node, series, options) {
    var data = parseSeries(series)
    node.innerHTML = ''
    if (!data.length) {
      node.innerHTML = '<p class="govuk-body-s">No data to display.</p>'
      return
    }

    var width = Math.max(node.clientWidth || 480, 320)
    var svg = d3
      .select(node)
      .append('svg')
      .attr('viewBox', '0 0 ' + width + ' ' + HEIGHT)
      .attr('preserveAspectRatio', 'xMinYMin meet')
      .attr('role', 'img')
      .attr('aria-label', options.ariaLabel)

    svg.append('title').text(options.title)
    svg
      .append('desc')
      .text(
        data.length +
          ' readings from ' +
          fullLabel(data[0].time) +
          ' to ' +
          fullLabel(data[data.length - 1].time) +
          '.'
      )

    var x = d3
      .scaleUtc()
      .domain(
        d3.extent(data, function (d) {
          return d.time
        })
      )
      .range([MARGIN.left, width - MARGIN.right])

    var yMax = d3.max(data, function (d) {
      return d.value
    })
    var y = d3
      .scaleLinear()
      .domain([0, yMax > 0 ? yMax * 1.1 : 1])
      .nice()
      .range([HEIGHT - MARGIN.bottom, MARGIN.top])

    svg
      .append('g')
      .attr('class', 'app-chart__grid')
      .attr('transform', 'translate(' + MARGIN.left + ',0)')
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickSize(-(width - MARGIN.left - MARGIN.right))
          .tickFormat('')
      )
      .call(function (g) {
        g.select('.domain').remove()
      })

    svg
      .append('g')
      .attr('class', 'app-chart__axis')
      .attr('transform', 'translate(0,' + (HEIGHT - MARGIN.bottom) + ')')
      .call(
        d3
          .axisBottom(x)
          .ticks(width > 500 ? 6 : 4)
          .tickFormat(axisLabel)
          .tickSizeOuter(0)
      )

    svg
      .append('g')
      .attr('class', 'app-chart__axis')
      .attr('transform', 'translate(' + MARGIN.left + ',0)')
      .call(d3.axisLeft(y).ticks(5))
      .call(function (g) {
        g.select('.domain').remove()
      })

    var line = d3
      .line()
      .x(function (d) {
        return x(d.time)
      })
      .y(function (d) {
        return y(d.value)
      })

    svg
      .append('path')
      .datum(data)
      .attr('fill', 'none')
      .attr('stroke', options.colour)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', DASH[options.lineStyle] || null)
      .attr('d', line)

    var focus = svg
      .append('circle')
      .attr('r', 4)
      .attr('fill', options.colour)
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1)
      .style('display', 'none')

    function activate(d) {
      focus.attr('cx', x(d.time)).attr('cy', y(d.value)).style('display', null)
      var rect = svg.node().getBoundingClientRect()
      var scale = rect.width / width
      showTooltip(
        '<strong>' +
          options.name +
          '</strong><br>' +
          d.value +
          ' ' +
          unit +
          '<br>' +
          fullLabel(d.time),
        window.scrollX + rect.left + x(d.time) * scale,
        window.scrollY + rect.top + y(d.value) * scale - 16
      )
    }
    function deactivate() {
      focus.style('display', 'none')
      hideTooltip()
    }

    var bisect = d3.bisector(function (d) {
      return d.time
    }).center

    svg
      .append('rect')
      .attr('fill', 'transparent')
      .attr('x', MARGIN.left)
      .attr('y', MARGIN.top)
      .attr('width', Math.max(0, width - MARGIN.left - MARGIN.right))
      .attr('height', Math.max(0, HEIGHT - MARGIN.top - MARGIN.bottom))
      .on('mousemove', function (event) {
        var d = data[bisect(data, x.invert(d3.pointer(event)[0]))]
        if (d) {
          activate(d)
        }
      })
      .on('mouseleave', deactivate)

    // Sample focusable points so keyboard users get tooltips without an
    // excessive number of tab stops; the full series is in the data table.
    var step = Math.max(1, Math.ceil(data.length / MAX_FOCUSABLE))
    var focusable = data.filter(function (d, i) {
      return i % step === 0 || i === data.length - 1
    })

    svg
      .append('g')
      .selectAll('circle.app-chart__point')
      .data(focusable)
      .enter()
      .append('circle')
      .attr('class', 'app-chart__point')
      .attr('cx', function (d) {
        return x(d.time)
      })
      .attr('cy', function (d) {
        return y(d.value)
      })
      .attr('r', 12)
      .attr('fill', 'transparent')
      .attr('tabindex', 0)
      .attr('role', 'img')
      .attr('aria-label', function (d) {
        return (
          options.name +
          ': ' +
          d.value +
          ' ' +
          unit +
          ' at ' +
          fullLabel(d.time)
        )
      })
      .on('focus', function (event, d) {
        activate(d)
      })
      .on('blur', deactivate)
      .on('mouseenter', function (event, d) {
        activate(d)
      })
  }

  function drawSmallMultiples() {
    var nodes = document.querySelectorAll('.js-chart')
    Array.prototype.forEach.call(nodes, function (node) {
      var code = node.dataset.code
      var pollutant = pollutants.find(function (p) {
        return p.code === code
      })
      if (!pollutant) {
        return
      }
      drawChart(node, pollutant.series, {
        name: pollutant.name,
        colour: pollutant.colour,
        lineStyle: pollutant.line,
        title: pollutant.name + ' readings (' + unit + ')',
        ariaLabel:
          pollutant.name +
          ' readings in ' +
          unit +
          ' over the selected timeframe'
      })
    })
  }

  function nearestPoint(series, time) {
    var bisect = d3.bisector(function (d) {
      return d.time
    }).center
    return series[bisect(series, time)]
  }

  function legendSwatch(pollutant) {
    var dash = DASH[pollutant.line]
    return (
      '<svg class="app-chart-legend__swatch" width="26" height="8" aria-hidden="true" focusable="false">' +
      '<line x1="0" y1="4" x2="26" y2="4" stroke="' +
      pollutant.colour +
      '" stroke-width="3"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : '') +
      '/></svg>'
    )
  }

  function buildLegend(node) {
    node.innerHTML = pollutants
      .map(function (p) {
        return (
          '<span class="app-chart-legend__item">' +
          legendSwatch(p) +
          '<span class="app-chart-legend__label">' +
          p.name +
          '</span></span>'
        )
      })
      .join('')
  }

  function drawCombined(node) {
    node.innerHTML = ''
    var seriesList = pollutants
      .map(function (p) {
        return { pollutant: p, data: parseSeries(p.series) }
      })
      .filter(function (s) {
        return s.data.length
      })
    if (!seriesList.length) {
      node.innerHTML = '<p class="govuk-body-s">No data to display.</p>'
      return
    }

    var width = Math.max(node.clientWidth || 640, 320)
    var height = 360
    var margin = { top: 12, right: 18, bottom: 30, left: 44 }

    var svg = d3
      .select(node)
      .append('svg')
      .attr('viewBox', '0 0 ' + width + ' ' + height)
      .attr('preserveAspectRatio', 'xMinYMin meet')
      .attr('role', 'img')
      .attr(
        'aria-label',
        'Combined hourly readings in ' +
          unit +
          ' for ' +
          seriesList
            .map(function (s) {
              return s.pollutant.name
            })
            .join(', ')
      )
    svg
      .append('title')
      .text('Combined hourly pollutant readings (' + unit + ')')

    var allPoints = seriesList.reduce(function (acc, s) {
      return acc.concat(s.data)
    }, [])

    var x = d3
      .scaleUtc()
      .domain(
        d3.extent(allPoints, function (d) {
          return d.time
        })
      )
      .range([margin.left, width - margin.right])
    var yMax = d3.max(allPoints, function (d) {
      return d.value
    })
    var y = d3
      .scaleLinear()
      .domain([0, yMax > 0 ? yMax * 1.1 : 1])
      .nice()
      .range([height - margin.bottom, margin.top])

    svg
      .append('g')
      .attr('class', 'app-chart__grid')
      .attr('transform', 'translate(' + margin.left + ',0)')
      .call(
        d3
          .axisLeft(y)
          .ticks(6)
          .tickSize(-(width - margin.left - margin.right))
          .tickFormat('')
      )
      .call(function (g) {
        g.select('.domain').remove()
      })
    svg
      .append('g')
      .attr('class', 'app-chart__axis')
      .attr('transform', 'translate(0,' + (height - margin.bottom) + ')')
      .call(
        d3
          .axisBottom(x)
          .ticks(width > 500 ? 8 : 4)
          .tickFormat(axisLabel)
          .tickSizeOuter(0)
      )
    svg
      .append('g')
      .attr('class', 'app-chart__axis')
      .attr('transform', 'translate(' + margin.left + ',0)')
      .call(d3.axisLeft(y).ticks(6))
      .call(function (g) {
        g.select('.domain').remove()
      })

    var line = d3
      .line()
      .x(function (d) {
        return x(d.time)
      })
      .y(function (d) {
        return y(d.value)
      })
    seriesList.forEach(function (s) {
      svg
        .append('path')
        .datum(s.data)
        .attr('fill', 'none')
        .attr('stroke', s.pollutant.colour)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', DASH[s.pollutant.line] || null)
        .attr('d', line)
    })

    var guide = svg
      .append('line')
      .attr('class', 'app-chart__guide')
      .attr('y1', margin.top)
      .attr('y2', height - margin.bottom)
      .style('display', 'none')
    var dots = seriesList.map(function (s) {
      return svg
        .append('circle')
        .attr('r', 4)
        .attr('fill', s.pollutant.colour)
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 1)
        .style('display', 'none')
    })

    var times = allPoints.map(function (d) {
      return d.time.getTime()
    })
    times = Array.from(new Set(times))
      .sort(function (a, b) {
        return a - b
      })
      .map(function (t) {
        return new Date(t)
      })
    var bisectTimes = d3.bisector(function (d) {
      return d.getTime()
    }).center

    function activateAt(time) {
      guide.attr('x1', x(time)).attr('x2', x(time)).style('display', null)
      var rows = ''
      seriesList.forEach(function (s, idx) {
        var pt = nearestPoint(s.data, time)
        if (pt) {
          dots[idx]
            .attr('cx', x(pt.time))
            .attr('cy', y(pt.value))
            .style('display', null)
          rows +=
            '<div class="app-chart__tooltip-row">' +
            legendSwatch(s.pollutant) +
            ' ' +
            s.pollutant.name +
            ': ' +
            pt.value +
            ' ' +
            unit +
            '</div>'
        }
      })
      var rect = svg.node().getBoundingClientRect()
      var scale = rect.width / width
      showTooltip(
        '<strong>' + fullLabel(time) + '</strong>' + rows,
        window.scrollX + rect.left + x(time) * scale,
        window.scrollY + rect.top + margin.top * scale
      )
    }
    function deactivate() {
      guide.style('display', 'none')
      dots.forEach(function (dd) {
        dd.style('display', 'none')
      })
      hideTooltip()
    }

    svg
      .append('rect')
      .attr('fill', 'transparent')
      .attr('x', margin.left)
      .attr('y', margin.top)
      .attr('width', Math.max(0, width - margin.left - margin.right))
      .attr('height', Math.max(0, height - margin.top - margin.bottom))
      .on('mousemove', function (event) {
        var nt = times[bisectTimes(times, x.invert(d3.pointer(event)[0]))]
        if (nt) {
          activateAt(nt)
        }
      })
      .on('mouseleave', deactivate)

    var step = Math.max(1, Math.ceil(times.length / MAX_FOCUSABLE))
    var focusTimes = times.filter(function (t, i) {
      return i % step === 0 || i === times.length - 1
    })
    svg
      .append('g')
      .selectAll('rect.app-chart__band')
      .data(focusTimes)
      .enter()
      .append('rect')
      .attr('class', 'app-chart__band')
      .attr('x', function (d) {
        return x(d) - 6
      })
      .attr('y', margin.top)
      .attr('width', 12)
      .attr('height', Math.max(0, height - margin.top - margin.bottom))
      .attr('fill', 'transparent')
      .attr('tabindex', 0)
      .attr('role', 'img')
      .attr('aria-label', function (d) {
        var parts = seriesList
          .map(function (s) {
            var pt = nearestPoint(s.data, d)
            return pt ? s.pollutant.name + ' ' + pt.value + ' ' + unit : null
          })
          .filter(Boolean)
        return fullLabel(d) + '. ' + parts.join(', ')
      })
      .on('focus', function (event, d) {
        activateAt(d)
      })
      .on('blur', deactivate)
  }

  function init() {
    var wrap = document.querySelector('.app-charts')
    var layout = wrap ? wrap.dataset.layout : 'small-multiples'
    if (layout === 'combined') {
      var combined = document.querySelector('.js-chart-combined')
      var legend = document.querySelector('.js-chart-legend')
      if (combined) {
        drawCombined(combined)
      }
      if (legend) {
        buildLegend(legend)
      }
    } else {
      drawSmallMultiples()
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
