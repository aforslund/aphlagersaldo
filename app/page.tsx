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
  const router = useRouter()

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
        alert('Error parsing CSV: ' + error.message)
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
        alert(`Loaded NYCE data for ${Object.keys(nyceData).length} SKUs`)
      },
      error: (error) => {
        alert('Error parsing NYCE CSV: ' + error.message)
      },
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setResults([])
    setErrors([])
    setProgressMessage('Initializing...')
    setProgressCurrent(0)
    setProgressTotal(0)

    try {
      // Validate Full Check mode requires NYCE CSV
      if (checkMode === 'full' && !nyceCsvData) {
        alert('Full Check mode requires NYCE CSV upload')
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
          alert('Please enter at least one PSID for Spot-check mode')
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

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk = decoder.decode(value)
          const lines = chunk.split('\n')

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6))

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
              } else if (data.type === 'complete') {
                setResults(data.results)
                setErrors(data.errors)
              }
            }
          }
        }
      }
    } catch (error) {
      alert('Error checking stock: ' + error)
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

  const okResults = results.filter(r => r.status === 'ok')
  const issueResults = results.filter(r => r.status === 'issue')

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
            border: '1px solid #fca5a5',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '2rem'
          }}>
            <h3 style={{ fontWeight: 'bold', color: '#991b1b', marginBottom: '0.5rem' }}>Errors:</h3>
            <ul style={{ listStyle: 'disc', paddingLeft: '1.5rem', color: '#991b1b' }}>
              {errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div>
            {/* Summary */}
            <div style={{
              background: 'white',
              padding: '1rem',
              borderRadius: '8px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
              marginBottom: '1rem',
              display: 'flex',
              gap: '2rem'
            }}>
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

            {/* Issue Results */}
            {issueResults.length > 0 && (
              <div>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1rem', color: '#ef4444' }}>
                  Items Requiring Attention
                </h2>
                {issueResults.map((result, i) => (
                  <ResultCard key={i} result={result} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ResultCard({ result }: { result: ProductStockResult }) {
  const isOk = result.status === 'ok'

  return (
    <div style={{
      background: 'white',
      border: `2px solid ${isOk ? '#10b981' : '#ef4444'}`,
      borderRadius: '8px',
      padding: '1.5rem',
      marginBottom: '1rem',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
    }}>
      {/* Header */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '0.5rem' }}>
          <div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#1f2937' }}>
              {result.psid}
            </h3>
            <p style={{ color: '#6b7280', fontSize: '0.875rem' }}>{result.productName}</p>
          </div>
          <span style={{
            padding: '0.25rem 0.75rem',
            background: isOk ? '#d1fae5' : '#fee2e2',
            color: isOk ? '#065f46' : '#991b1b',
            borderRadius: '9999px',
            fontSize: '0.75rem',
            fontWeight: '600'
          }}>
            {result.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Stock Levels */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '1rem',
        marginBottom: '1rem',
        padding: '1rem',
        background: '#f9fafb',
        borderRadius: '4px'
      }}>
        <div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Google Feed</div>
          <div style={{ fontWeight: 'bold', color: result.googleSellable === null ? '#6b7280' : (result.googleSellable ? '#10b981' : '#ef4444') }}>
            {result.googleSellable === null ? 'SKIPPED' : (result.googleSellable ? 'SELLABLE' : 'NOT SELLABLE')}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>CommerceTools</div>
          <div style={{ fontWeight: 'bold', color: result.commerceToolsStock > 0 ? '#10b981' : '#ef4444' }}>
            {result.commerceToolsStock}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>Fluent</div>
          <div style={{ fontWeight: 'bold', color: result.fluentStock > 0 ? '#10b981' : '#ef4444' }}>
            {result.fluentStock}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>NYCE OnHand</div>
          <div style={{ fontWeight: 'bold', color: (result.nyceStock?.onHandQty || 0) > 0 ? '#10b981' : '#ef4444' }}>
            {result.nyceStock?.onHandQty || 0}
          </div>
        </div>
      </div>

      {/* Analysis */}
      {result.analysis && (
        <div style={{
          padding: '1rem',
          background: isOk ? '#ecfdf5' : '#fef2f2',
          borderLeft: `4px solid ${isOk ? '#10b981' : '#ef4444'}`,
          marginBottom: '1rem'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '0.5rem', color: '#1f2937' }}>Analysis:</div>
          <div style={{ color: '#374151' }}>{result.analysis}</div>
        </div>
      )}

      {/* Details */}
      {result.details.length > 0 && (
        <div>
          <div style={{ fontWeight: '600', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#1f2937' }}>
            Details:
          </div>
          <ul style={{ listStyle: 'disc', paddingLeft: '1.5rem', fontSize: '0.875rem', color: '#374151' }}>
            {result.details.map((detail, i) => (
              <li key={i} style={{ marginBottom: '0.25rem' }}>{detail}</li>
            ))}
          </ul>
        </div>
      )}

      {/* NYCE Details */}
      {result.nyceStock && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: '#f9fafb',
          borderRadius: '4px',
          fontSize: '0.875rem'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '0.5rem', color: '#1f2937' }}>NYCE Stock Details:</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem' }}>
            <div><span style={{ color: '#6b7280' }}>Physical:</span> <strong>{result.nyceStock.physicalQty}</strong></div>
            <div><span style={{ color: '#6b7280' }}>OnHand:</span> <strong>{result.nyceStock.onHandQty}</strong></div>
            <div><span style={{ color: '#6b7280' }}>InOrder:</span> <strong>{result.nyceStock.inOrderQty}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Stopped:</span> <strong>{result.nyceStock.stoppedQty}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Allocated:</span> <strong>{result.nyceStock.allocatedQty}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Available:</span> <strong>{result.nyceStock.onHandQty - result.nyceStock.inOrderQty}</strong></div>
          </div>
        </div>
      )}
    </div>
  )
}
