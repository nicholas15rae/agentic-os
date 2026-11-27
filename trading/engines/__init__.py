"""Execution engines. Each one turns market data into OrderIntents and hands them to
the desk, which runs the Security Detail. Engines never place, size-past-caps or
approve anything themselves, and share the bridge, Security Detail and kill switch.

  equities_commodities  Engine A — index / commodity ETFs, dynamic watchlist, brackets
  options_engine        Engine B — long options and debit verticals, expiry guard
"""
