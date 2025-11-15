'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import type { StockCheckResponse, ProductStockResult } from '@/types'

export default function StockCheckerPage() {
  const [psids, setPsids] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<ProductStockResult[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [showOkResults, setShowOkResults] = useState(false)
  const [progressMessage, setProgressMessage] = useState('')
  const [progressCurrent, setProgressCurrent] = useState(0)
  const [progressTotal, setProgressTotal] = useState(0)
  const [checkMode, setCheckMode] = useState<'full' | 'spot'>('spot')
  const [nyceCsvData, setNyceCsvData] = useState<any>(null)
  const [summaryStats, setSummaryStats] = useState<any>(null)
  const [sortBy, setSortBy] = useState<'none' | 'nyce' | 'fluent' | 'ct'>('none')
  const [nyceUnallocatedFilter, setNyceUnallocatedFilter] = useState<number>(0)  // 0 means no filter
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: 'success' | 'error' | 'info' }>>([])
  const router = useRouter()

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 5000) // Auto-dismiss after 5 seconds
  }

  const dismissToast = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  const handlePsidFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    Papa.parse(file, {
      complete: (results) => {
        // Extract PSIDs from CSV (assuming they're in the first column or as single values)
        const psidList: string[] = []
        results.data.forEach((row: any) => {
          if (Array.isArray(row)) {
            // If row is an array, take first non-empty value
            const psid = row.find((cell: string) => cell && cell.trim())
            if (psid && psid.trim()) psidList.push(psid.trim())
          } else if (typeof row === 'string' && row.trim()) {
            psidList.push(row.trim())
          }
        })
        setPsids(psidList.join(', '))
      },
      error: (error) => {
        showToast('Error parsing CSV: ' + error.message, 'error')
      },
    })
  }

  const handleNyceCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    Papa.parse(file, {
      header: true,
      complete: (results) => {
        const nyceData: any = {}
        results.data.forEach((row: any) => {
          if (row.SKU) {
            nyceData[row.SKU.trim()] = {
              balance: parseFloat(row.Balance || '0'),
              inOrder: parseFloat(row.InOrder || '0'),
            }
          }
        })
        setNyceCsvData(nyceData)
        showToast(`✅ Loaded NYCE data for ${Object.keys(nyceData).length} SKUs`, 'success')
      },
      error: (error) => {
        showToast('Error parsing NYCE CSV: ' + error.message, 'error')
      },
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setResults([])
    setErrors([])
    setSummaryStats(null)
    setProgressMessage('Initializing...')
    setProgressCurrent(0)
    setProgressTotal(0)

    try {
      // Validate Full Check mode requires NYCE CSV
      if (checkMode === 'full' && !nyceCsvData) {
        showToast('Full Check mode requires NYCE CSV upload', 'error')
        setLoading(false)
        return
      }

      let psidList: string[] = []

      // For Full Check, we don't need PSIDs - they come from Google Feed
      if (checkMode === 'full') {
        psidList = [] // Will be populated from Google Feed out-of-stock items
      } else {
        // For Spot-check, PSIDs are required
        psidList = psids
          .split(/[,\n]/)
          .map(p => p.trim())
          .filter(p => p.length > 0)

        if (psidList.length === 0) {
          showToast('Please enter at least one PSID for Spot-check mode', 'error')
          setLoading(false)
          return
        }
      }

      setProgressTotal(psidList.length)

      // Use streaming endpoint for real-time updates
      const response = await fetch('/api/stock-check-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          psids: psidList,
          checkMode,
          nyceCsvData,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to check stock')
      }

      // Read streaming response
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      const tempResults: ProductStockResult[] = []
      const tempErrors: string[] = []
      let buffer = '' // Buffer for incomplete chunks

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          // Append to buffer to handle partial chunks
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')

          // Keep the last incomplete line in the buffer
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim()
              if (!jsonStr) continue // Skip empty data lines

              try {
                const data = JSON.parse(jsonStr)

                if (data.type === 'progress') {
                  setProgressMessage(data.message)
                  if (data.current !== undefined) setProgressCurrent(data.current)
                  if (data.total !== undefined) setProgressTotal(data.total)
                } else if (data.type === 'result') {
                  tempResults.push(data.result)
                  setResults([...tempResults])
                } else if (data.type === 'error') {
                  tempErrors.push(data.message)
                  setErrors([...tempErrors])
                } else if (data.type === 'summary') {
                  setSummaryStats(data)
                } else if (data.type === 'complete') {
                  setResults(data.results)
                  setErrors(data.errors)
                }
              } catch (parseError) {
                console.error('Failed to parse SSE data:', jsonStr)
                console.error('Parse error:', parseError)
                tempErrors.push(`Stream parsing error: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
                setErrors([...tempErrors])
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Stock check error:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      setErrors(prev => [...prev, `Error checking stock: ${errorMessage}`])
      showToast(`Error checking stock: ${errorMessage}`, 'error')
    } finally {
      setLoading(false)
      setProgressMessage('')
    }
  }

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  // Sort results based on selected criteria
  const getSortedResults = (resultsToSort: ProductStockResult[]) => {
    if (sortBy === 'none') return resultsToSort

    return [...resultsToSort].sort((a, b) => {
      if (sortBy === 'nyce') {
        const aUnallocated = a.nyceStock ? (a.nyceStock.onHandQty - a.nyceStock.inOrderQty) : 0
        const bUnallocated = b.nyceStock ? (b.nyceStock.onHandQty - b.nyceStock.inOrderQty) : 0
        return bUnallocated - aUnallocated  // Descending order
      } else if (sortBy === 'fluent') {
        return b.fluentStock - a.fluentStock  // Descending order
      } else if (sortBy === 'ct') {
        return b.commerceToolsStock - a.commerceToolsStock  // Descending order
      }
      return 0
    })
  }

  const okResults = getSortedResults(results.filter(r => r.status === 'ok'))
  let issueResults = getSortedResults(results.filter(r => r.status === 'issue' || r.status === 'warning'))

  // Apply NYCE unallocated filter
  if (nyceUnallocatedFilter > 0) {
    issueResults = issueResults.filter(r => {
      if (!r.nyceStock) return false
      const nyceUnallocated = r.nyceStock.onHandQty - r.nyceStock.inOrderQty
      return nyceUnallocated >= nyceUnallocatedFilter
    })
  }

  // Group issue results by analysis type
  const groupedIssues = issueResults.reduce((groups, result) => {
    const category = result.analysis || 'Other'
    if (!groups[category]) {
      groups[category] = []
    }
    groups[category].push(result)
    return groups
  }, {} as Record<string, ProductStockResult[]>)

  // Sort groups by count (largest first)
  const sortedIssueGroups = Object.entries(groupedIssues).sort((a, b) => b[1].length - a[1].length)

  return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', padding: '2rem' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', color: '#1f2937' }}>
            Stock Level Checker
          </h1>
          <button
            onClick={handleLogout}
            style={{
              padding: '0.5rem 1rem',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            Logout
          </button>
        </div>

        {/* Input Form */}
        <div style={{ background: 'white', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '2rem' }}>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: '500', color: '#374151' }}>
                {checkMode === 'spot' ? 'Upload CSV or Enter PSIDs (Required)' : 'PSIDs (Not needed for Full Check)'}
              </label>
              {checkMode === 'spot' && (
                <input
                  type="file"
                  accept=".csv"
                  onChange={handlePsidFileUpload}
                  style={{ marginBottom: '1rem', display: 'block' }}
                />
              )}
              <textarea
                value={psids}
                onChange={(e) => setPsids(e.target.value)}
                placeholder={checkMode === 'spot'
                  ? "Enter PSIDs (comma or newline separated)"
                  : "Not needed - Full Check uses Google Feed out-of-stock items"}
                rows={5}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  fontSize: '1rem',
                  fontFamily: 'monospace',
                  background: checkMode === 'full' ? '#f3f4f6' : 'white',
                  cursor: checkMode === 'full' ? 'not-allowed' : 'text'
                }}
                disabled={checkMode === 'full'}
              />
              <p style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.5rem' }}>
                {checkMode === 'spot'
                  ? 'Example: 38454, 3849, 3848 or one per line'
                  : 'Full Check automatically processes all items marked as out-of-stock in Google Feed'}
              </p>
            </div>

            {/* Check Mode Selection */}
            <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#f9fafb', borderRadius: '4px' }}>
              <h3 style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.75rem', color: '#374151' }}>
                Check Mode
              </h3>

              <label style={{ display: 'flex', alignItems: 'start', marginBottom: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="checkMode"
                  value="spot"
                  checked={checkMode === 'spot'}
                  onChange={(e) => {
                    setCheckMode('spot')
                    setNyceCsvData(null)
                  }}
                  style={{ marginRight: '0.5rem', marginTop: '0.25rem', cursor: 'pointer' }}
                />
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: '600', color: '#374151' }}>
                    Spot-check
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.25rem' }}>
                    Quick check of Autocomplete API (CommerceTools) and Fluent only
                  </div>
                </div>
              </label>

              <label style={{ display: 'flex', alignItems: 'start', marginBottom: '0.75rem', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="checkMode"
                  value="full"
                  checked={checkMode === 'full'}
                  onChange={(e) => setCheckMode('full')}
                  style={{ marginRight: '0.5rem', marginTop: '0.25rem', cursor: 'pointer' }}
                />
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: '600', color: '#374151' }}>
                    Full Check
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.25rem' }}>
                    Checks all out-of-stock items from Google Feed against NYCE, Fluent, and CommerceTools
                  </div>
                </div>
              </label>

              {checkMode === 'full' && (
                <div style={{ marginLeft: '1.5rem', marginTop: '1rem', padding: '1rem', background: 'white', borderRadius: '4px', border: '1px solid #d1d5db' }}>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: '600', color: '#374151', marginBottom: '0.5rem' }}>
                    Upload NYCE CSV (Required) *
                  </label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleNyceCsvUpload}
                    style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}
                  />
                  <p style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.5rem' }}>
                    CSV format: SKU, Balance, InOrder
                  </p>
                  {nyceCsvData ? (
                    <div style={{ padding: '0.5rem', background: '#d1fae5', borderRadius: '4px', fontSize: '0.75rem', color: '#065f46' }}>
                      ✓ NYCE CSV loaded ({Object.keys(nyceCsvData).length} SKUs)
                    </div>
                  ) : (
                    <div style={{ padding: '0.5rem', background: '#fef2f2', borderRadius: '4px', fontSize: '0.75rem', color: '#991b1b' }}>
                      ⚠ NYCE CSV required for Full Check mode
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '0.75rem 1.5rem',
                background: loading ? '#9ca3af' : '#667eea',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '1rem',
                fontWeight: '500',
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              {loading ? 'Checking...' : 'Check Stock Levels'}
            </button>
          </form>
        </div>

        {/* Progress Indicator */}
        {loading && (
          <div style={{
            background: 'white',
            padding: '2rem',
            borderRadius: '8px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            marginBottom: '2rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{
                width: '40px',
                height: '40px',
                border: '4px solid #e5e7eb',
                borderTop: '4px solid #667eea',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
                marginRight: '1rem'
              }} />
              <div>
                <div style={{ fontSize: '1.125rem', fontWeight: '600', color: '#1f2937', marginBottom: '0.25rem' }}>
                  {progressMessage || 'Processing...'}
                </div>
                {progressTotal > 0 && (
                  <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                    {progressCurrent} / {progressTotal} items
                  </div>
                )}
              </div>
            </div>
            {progressTotal > 0 && (
              <div style={{
                width: '100%',
                height: '8px',
                background: '#e5e7eb',
                borderRadius: '4px',
                overflow: 'hidden'
              }}>
                <div style={{
                  width: `${(progressCurrent / progressTotal) * 100}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)',
                  transition: 'width 0.3s ease'
                }} />
              </div>
            )}
          </div>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <div style={{
            background: '#fee2e2',
            border: '2px solid #ef4444',
            borderRadius: '8px',
            padding: '1.5rem',
            marginBottom: '2rem',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
          }}>
            <h3 style={{ fontWeight: 'bold', color: '#991b1b', marginBottom: '1rem', fontSize: '1.125rem' }}>
              ⚠️ Errors Occurred ({errors.length})
            </h3>
            <div style={{ background: 'white', borderRadius: '4px', padding: '1rem' }}>
              <ul style={{ listStyle: 'none', paddingLeft: '0', color: '#991b1b', margin: 0 }}>
                {errors.map((error, i) => (
                  <li key={i} style={{
                    marginBottom: '0.5rem',
                    paddingBottom: '0.5rem',
                    borderBottom: i < errors.length - 1 ? '1px solid #fecaca' : 'none',
                    fontSize: '0.875rem',
                    fontFamily: 'monospace'
                  }}>
                    <strong>{i + 1}.</strong> {error}
                  </li>
                ))}
              </ul>
            </div>
            <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: '#7f1d1d', background: '#fef2f2', padding: '0.75rem', borderRadius: '4px' }}>
              <strong>Troubleshooting tips:</strong>
              <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.25rem' }}>
                <li>Check that all environment variables are set correctly</li>
                <li>Verify API endpoints are accessible</li>
                <li>Check browser console for detailed error logs</li>
                <li>Ensure NYCE CSV is properly formatted (SKU, Balance, InOrder columns)</li>
              </ul>
            </div>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div>
            {/* Summary Statistics (Full Check Only) */}
            {summaryStats && (
              <div style={{
                background: '#f0f9ff',
                border: '2px solid #3b82f6',
                padding: '1.5rem',
                borderRadius: '8px',
                marginBottom: '1rem'
              }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '1rem', color: '#1e40af' }}>
                  Full Check Summary
                </h3>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '1rem'
                }}>
                  <div style={{ padding: '0.75rem', background: 'white', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Total Google Feed Items</div>
                    <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#1f2937' }}>{summaryStats.totalGoogleFeedItems?.toLocaleString()}</div>
                  </div>
                  <div style={{ padding: '0.75rem', background: 'white', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Not Sellable in Feed</div>
                    <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#ef4444' }}>{summaryStats.notSellableCount?.toLocaleString()}</div>
                  </div>
                  <div style={{ padding: '0.75rem', background: 'white', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Items in NYCE CSV</div>
                    <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#8b5cf6' }}>{summaryStats.nyceCsvCount?.toLocaleString()}</div>
                  </div>
                  <div style={{ padding: '0.75rem', background: 'white', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Overlap (Out-of-Stock + in NYCE)</div>
                    <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#f59e0b' }}>{summaryStats.overlapCount?.toLocaleString()}</div>
                  </div>
                  <div style={{ padding: '0.75rem', background: 'white', borderRadius: '6px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Items with Unallocated Stock</div>
                    <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#10b981' }}>{summaryStats.itemsWithUnallocatedStock?.toLocaleString()}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Results Summary */}
            <div style={{
              background: 'white',
              padding: '1rem',
              borderRadius: '8px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
              marginBottom: '1rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', gap: '2rem' }}>
                <div>
                  <span style={{ fontSize: '0.875rem', color: '#6b7280' }}>Total Checked:</span>
                  <span style={{ fontSize: '1.5rem', fontWeight: 'bold', marginLeft: '0.5rem' }}>{results.length}</span>
                </div>
                <div>
                  <span style={{ fontSize: '0.875rem', color: '#10b981' }}>OK:</span>
                  <span style={{ fontSize: '1.5rem', fontWeight: 'bold', marginLeft: '0.5rem', color: '#10b981' }}>{okResults.length}</span>
                </div>
                <div>
                  <span style={{ fontSize: '0.875rem', color: '#ef4444' }}>Issues:</span>
                  <span style={{ fontSize: '1.5rem', fontWeight: 'bold', marginLeft: '0.5rem', color: '#ef4444' }}>{issueResults.length}</span>
                </div>
              </div>

              {/* Sorting and Filtering Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                {/* Sort Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>Sort by:</span>
                  <button
                    onClick={() => setSortBy('none')}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: sortBy === 'none' ? '#667eea' : 'white',
                      color: sortBy === 'none' ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: sortBy === 'none' ? '600' : '400'
                    }}
                  >
                    Default
                  </button>
                  <button
                    onClick={() => setSortBy('nyce')}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: sortBy === 'nyce' ? '#667eea' : 'white',
                      color: sortBy === 'nyce' ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: sortBy === 'nyce' ? '600' : '400'
                    }}
                  >
                    NYCE ↓
                  </button>
                  <button
                    onClick={() => setSortBy('fluent')}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: sortBy === 'fluent' ? '#667eea' : 'white',
                      color: sortBy === 'fluent' ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: sortBy === 'fluent' ? '600' : '400'
                    }}
                  >
                    Fluent ↓
                  </button>
                  <button
                    onClick={() => setSortBy('ct')}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: sortBy === 'ct' ? '#667eea' : 'white',
                      color: sortBy === 'ct' ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: sortBy === 'ct' ? '600' : '400'
                    }}
                  >
                    CT ↓
                  </button>
                </div>

                {/* NYCE Unallocated Filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderLeft: '1px solid #d1d5db', paddingLeft: '1rem' }}>
                  <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>NYCE unallocated ≥</span>
                  <button
                    onClick={() => setNyceUnallocatedFilter(0)}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: nyceUnallocatedFilter === 0 ? '#10b981' : 'white',
                      color: nyceUnallocatedFilter === 0 ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: nyceUnallocatedFilter === 0 ? '600' : '400'
                    }}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setNyceUnallocatedFilter(1)}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: nyceUnallocatedFilter === 1 ? '#10b981' : 'white',
                      color: nyceUnallocatedFilter === 1 ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: nyceUnallocatedFilter === 1 ? '600' : '400'
                    }}
                  >
                    1+
                  </button>
                  <button
                    onClick={() => setNyceUnallocatedFilter(2)}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: nyceUnallocatedFilter === 2 ? '#10b981' : 'white',
                      color: nyceUnallocatedFilter === 2 ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: nyceUnallocatedFilter === 2 ? '600' : '400'
                    }}
                  >
                    2+
                  </button>
                  <button
                    onClick={() => setNyceUnallocatedFilter(5)}
                    style={{
                      padding: '0.25rem 0.75rem',
                      background: nyceUnallocatedFilter === 5 ? '#10b981' : 'white',
                      color: nyceUnallocatedFilter === 5 ? 'white' : '#374151',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      fontWeight: nyceUnallocatedFilter === 5 ? '600' : '400'
                    }}
                  >
                    5+
                  </button>
                </div>
              </div>
            </div>

            {/* OK Results (Collapsible) */}
            {okResults.length > 0 && (
              <div style={{
                background: 'white',
                borderRadius: '8px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                marginBottom: '1rem',
                overflow: 'hidden'
              }}>
                <button
                  onClick={() => setShowOkResults(!showOkResults)}
                  style={{
                    width: '100%',
                    padding: '1rem',
                    background: '#d1fae5',
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontWeight: '600',
                    color: '#065f46',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}
                >
                  <span>OK Items ({okResults.length})</span>
                  <span>{showOkResults ? '▼' : '►'}</span>
                </button>
                {showOkResults && (
                  <div style={{ padding: '1rem' }}>
                    {okResults.map((result, i) => (
                      <ResultCard key={i} result={result} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Issue Results - Grouped by Type */}
            {issueResults.length > 0 && (
              <div>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1rem', color: '#ef4444' }}>
                  Items Requiring Attention ({issueResults.length})
                </h2>
                {sortedIssueGroups.map(([category, items], groupIndex) => (
                  <IssueGroup
                    key={groupIndex}
                    category={category}
                    items={items}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast Notifications */}
      <div style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        maxWidth: '400px'
      }}>
        {toasts.map(toast => (
          <div
            key={toast.id}
            style={{
              background: toast.type === 'error' ? '#fee2e2' : toast.type === 'success' ? '#d1fae5' : '#dbeafe',
              border: `2px solid ${toast.type === 'error' ? '#ef4444' : toast.type === 'success' ? '#10b981' : '#3b82f6'}`,
              borderRadius: '8px',
              padding: '1rem',
              boxShadow: '0 10px 15px rgba(0,0,0,0.1)',
              display: 'flex',
              alignItems: 'start',
              justifyContent: 'space-between',
              animation: 'slideIn 0.3s ease-out',
              minWidth: '300px'
            }}
          >
            <div style={{ flex: 1, display: 'flex', alignItems: 'start', gap: '0.75rem' }}>
              <span style={{ fontSize: '1.25rem' }}>
                {toast.type === 'error' ? '❌' : toast.type === 'success' ? '✅' : 'ℹ️'}
              </span>
              <p style={{
                margin: 0,
                color: toast.type === 'error' ? '#991b1b' : toast.type === 'success' ? '#065f46' : '#1e40af',
                fontSize: '0.875rem',
                lineHeight: '1.4',
                wordBreak: 'break-word'
              }}>
                {toast.message}
              </p>
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: '1.25rem',
                color: toast.type === 'error' ? '#991b1b' : toast.type === 'success' ? '#065f46' : '#1e40af',
                padding: 0,
                marginLeft: '0.5rem',
                lineHeight: 1,
                opacity: 0.5
              }}
              onMouseOver={(e) => e.currentTarget.style.opacity = '1'}
              onMouseOut={(e) => e.currentTarget.style.opacity = '0.5'}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function IssueGroup({ category, items }: { category: string, items: ProductStockResult[] }) {
  const [isExpanded, setIsExpanded] = useState(false)  // Start collapsed so you can see counts

  // Determine color based on category
  const getColorScheme = () => {
    if (category.includes('SPÄRR') || category.includes('block')) {
      return { bg: '#fef3c7', text: '#92400e', border: '#f59e0b' }  // Yellow/amber for blocks
    } else if (category.includes('SYNKPROBLEM') || category.includes('sync')) {
      return { bg: '#fecaca', text: '#991b1b', border: '#ef4444' }  // Red for sync issues
    } else if (category.includes('LAGERSYNK') || category.includes('UTSÅLT')) {
      return { bg: '#fed7aa', text: '#9a3412', border: '#f97316' }  // Orange for inventory sync
    } else if (category.includes('INLEVERAT') || category.includes('delivered')) {
      return { bg: '#e9d5ff', text: '#581c87', border: '#a855f7' }  // Purple for not delivered
    } else {
      return { bg: '#e5e7eb', text: '#374151', border: '#6b7280' }  // Gray for other
    }
  }

  const colors = getColorScheme()

  return (
    <div style={{
      background: 'white',
      borderRadius: '8px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      marginBottom: '1rem',
      overflow: 'hidden',
      border: `1px solid ${colors.border}`
    }}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          width: '100%',
          padding: '1rem',
          background: colors.bg,
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          fontWeight: '600',
          color: colors.text,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '1.25rem' }}>{isExpanded ? '▼' : '►'}</span>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: '700' }}>{category}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '0.125rem' }}>
              {items.length} {items.length === 1 ? 'item' : 'items'}
            </div>
          </div>
        </div>
        <div style={{
          padding: '0.25rem 0.75rem',
          background: 'white',
          borderRadius: '9999px',
          fontSize: '0.875rem',
          fontWeight: '700'
        }}>
          {items.length}
        </div>
      </button>
      {isExpanded && (
        <div style={{ padding: '1rem' }}>
          {items.map((result, i) => (
            <ResultCard key={i} result={result} />
          ))}
        </div>
      )}
    </div>
  )
}

function ResultCard({ result }: { result: ProductStockResult }) {
  const isOk = result.status === 'ok'
  const isWarning = result.status === 'warning'
  const isIssue = result.status === 'issue'

  // Color schemes
  const borderColor = isOk ? '#10b981' : isWarning ? '#f59e0b' : '#ef4444'
  const badgeBackground = isOk ? '#d1fae5' : isWarning ? '#fef3c7' : '#fee2e2'
  const badgeColor = isOk ? '#065f46' : isWarning ? '#92400e' : '#991b1b'
  const analysisBackground = isOk ? '#ecfdf5' : isWarning ? '#fffbeb' : '#fef2f2'

  return (
    <div style={{
      background: 'white',
      borderLeft: `4px solid ${borderColor}`,
      borderBottom: '1px solid #e5e7eb',
      padding: '0.75rem',
      marginBottom: '0.25rem'
    }}>
      {/* Excel-like header row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '1rem', alignItems: 'center', marginBottom: '0.5rem' }}>
        <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#6b7280' }}>
          {result.psid}
        </div>
        <div>
          {result.productUrl ? (
            <a
              href={result.productUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: '0.875rem',
                fontWeight: '700',
                color: '#2563eb',
                textDecoration: 'none'
              }}
              onMouseOver={(e) => e.currentTarget.style.textDecoration = 'underline'}
              onMouseOut={(e) => e.currentTarget.style.textDecoration = 'none'}
            >
              {result.productName}
            </a>
          ) : (
            <span style={{ fontSize: '0.875rem', fontWeight: '700', color: '#1f2937' }}>
              {result.productName}
            </span>
          )}
        </div>
        <span style={{
          padding: '0.125rem 0.5rem',
          background: badgeBackground,
          color: badgeColor,
          borderRadius: '4px',
          fontSize: '0.625rem',
          fontWeight: '600',
          textTransform: 'uppercase'
        }}>
          {result.status}
        </span>
      </div>

      {/* Stock table-like display */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
        gap: '0.75rem',
        fontSize: '0.75rem',
        marginBottom: '0.5rem',
        padding: '0.5rem',
        background: '#f9fafb',
        borderRadius: '4px'
      }}>
        {result.googleSellable !== null && (
          <div>
            <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.125rem' }}>Google</div>
            <div style={{ fontWeight: '600', color: result.googleSellable ? '#10b981' : '#ef4444' }}>
              {result.googleSellable ? 'Sellable' : 'Not Sellable'}
            </div>
          </div>
        )}
        <div>
          <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.125rem' }}>CT Stock</div>
          <div style={{ fontWeight: '600', color: result.commerceToolsStock > 0 ? '#10b981' : '#ef4444' }}>
            {result.commerceToolsStock}
          </div>
        </div>
        <div>
          <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.125rem' }}>Fluent Stock</div>
          <div style={{ fontWeight: '600', color: result.fluentStock > 0 ? '#10b981' : '#ef4444' }}>
            {result.fluentStock}
          </div>
        </div>
        {result.nyceStock && (
          <>
            <div>
              <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.125rem' }}>NYCE OnHand</div>
              <div style={{ fontWeight: '600', color: result.nyceStock.onHandQty > 0 ? '#10b981' : '#ef4444' }}>
                {result.nyceStock.onHandQty}
              </div>
            </div>
            <div>
              <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.125rem' }}>NYCE InOrder</div>
              <div style={{ fontWeight: '600' }}>{result.nyceStock.inOrderQty}</div>
            </div>
            <div>
              <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.125rem' }}>NYCE Unallocated</div>
              <div style={{ fontWeight: '600', color: (result.nyceStock.onHandQty - result.nyceStock.inOrderQty) > 0 ? '#10b981' : '#ef4444' }}>
                {result.nyceStock.onHandQty - result.nyceStock.inOrderQty}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Analysis - Compact */}
      {result.analysis && (
        <div style={{
          fontSize: '0.75rem',
          color: '#374151',
          padding: '0.5rem',
          background: analysisBackground,
          borderRadius: '4px',
          marginBottom: '0.5rem'
        }}>
          <strong>{result.analysis}</strong>
        </div>
      )}

      {/* Details - Compact list */}
      {result.details.length > 0 && (
        <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>
          {result.details.map((detail, i) => (
            <div key={i} style={{ marginBottom: '0.125rem' }}>• {detail}</div>
          ))}
        </div>
      )}
    </div>
  )
}
